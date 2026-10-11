import { catalogue } from './catalogue';
import { accountDirectory, accountDecision, cleanupStatus, retryCleanup } from './admin-accounts';
import { rateLimit, RateLimitError } from './api-security';
import { confirmDeletion } from './account-deletion';
import { reportSeller, reports, moderate, liftSuspension } from './moderation';
import { discoverSellers, sellerDetails, foodReviews } from './discovery';
import { z } from 'zod';
import { handleAdminMfa, requireAdminMfa, requireFreshAdminMfa } from './admin-mfa';
import { auditHistory } from './admin-review';
import { type AuthEnvironment } from './auth';
import { authOrigin, AuthUnavailableError } from './auth-policy';
import { HttpError, requireIdentity, requireRole, sessionUser, type AppUser } from './permissions';
import { sanitizeImage } from './image-sanitization';
import { submitVerification, adminQueue, adminVerificationDetails, privateDocument, decideVerification, publicVerificationMedia, withdrawPortrait, stageFile, type PrivateEnvironment } from './private-verification';

export interface FoodlaneEnvironment extends AuthEnvironment, PrivateEnvironment {}
const text = (max: number) => z.string().trim().min(1).max(max);
const number = (min: number, max: number) => z.union([z.number(), z.string().min(1)]).pipe(z.coerce.number<string | number>().finite().min(min).max(max));
const profileInput = z.object({ name: text(100), bio: text(700), address: text(250), hours: text(150), lat: number(-90, 90), lng: number(-180, 180) }).strict();
const foodInput = z.object({ id: text(100).optional(), name: text(120), description: text(700), category: text(50), price: number(1, 100000), image: text(250), available: z.boolean(), originalPrice: number(1,100000).nullable().optional(), offerLabel: z.string().trim().max(80).optional() }).strict();
type Seller = { id: string; name: string; status: string; lat: number; lng: number; address: string };
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
function storage(env: FoodlaneEnvironment) { if (!env.BUCKET) throw new HttpError(503, 'Storage unavailable.'); return env.BUCKET; }
async function body(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Request body required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function input(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
  try { return JSON.parse(new TextDecoder().decode(await body(request, 16384))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON.'); }
}
async function form(request: Request, max = 16 * 1024 * 1024) {
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new HttpError(415, 'Multipart form required.');
  return new Request(request.url, { method: 'POST', headers: request.headers, body: await body(request, max) }).formData();
}
async function ownSeller(db: D1Database, user: AppUser) {
  const seller = await db.prepare('SELECT id, name, status, address, lat, lng FROM sellers WHERE owner = ?').bind(user.userId).first<Seller>();
  if (!seller) throw new HttpError(404, 'Save your seller profile first.');
  return seller;
}
function approved(seller: Seller) { if (seller.status !== 'verified') throw new HttpError(403, 'Seller approval is required.'); }
async function storeProfilePhoto(env: FoodlaneEnvironment,userId:string,file:File) {
  const bytes=await sanitizeImage(file,env.IMAGES), id=crypto.randomUUID(), key='profile/'+userId+'/'+id+'.png', now=new Date().toISOString();
  const inserted=await env.DB.prepare("INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at,delete_after) SELECT ?,?,'profile-photo','media',?,'staging',?,? WHERE EXISTS(SELECT 1 FROM auth_users WHERE id=?)")
    .bind(id,userId,key,now,new Date(Date.parse(now)+3600000).toISOString(),userId).run();
  if(!inserted.meta.changes)throw new HttpError(409,'Account no longer available.');
  await storage(env).put(key,bytes,{httpMetadata:{contentType:'image/png',cacheControl:'private, no-store'}});
  const previous=await env.DB.prepare('SELECT image FROM auth_users WHERE id=?').bind(userId).first<{image:string|null}>();
  if(!previous) {
    const removedAt=new Date().toISOString();
    await env.DB.prepare("UPDATE verification_files SET kind='account-delete',state='deleting',delete_after=?,next_attempt_at=NULL WHERE id=? AND object_key=?").bind(removedAt,id,key).run();
    throw new HttpError(409,'Upload cancelled because the account changed.');
  }
  const attached=await env.DB.batch([
    env.DB.prepare("UPDATE auth_users SET image=?,updated_at=? WHERE id=? AND account_status='active'").bind(key,Date.now(),userId),
    env.DB.prepare("UPDATE verification_files SET state='attached',delete_after=NULL WHERE id=? AND subject=? AND object_key=? AND state='staging' AND EXISTS(SELECT 1 FROM auth_users WHERE id=? AND image=?)").bind(id,userId,key,userId,key),
    ...(previous.image?.startsWith('profile/'+userId+'/') ? [env.DB.prepare("UPDATE verification_files SET kind='account-delete',state='deleting',delete_after=?,next_attempt_at=NULL WHERE subject=? AND object_key=? AND kind='profile-photo'").bind(now,userId,previous.image)] : []),
  ]);
  if(!attached[0].meta.changes||!attached[1].meta.changes)throw new HttpError(409,'Upload cancelled because the account changed.');
}
async function imageResponse(env: FoodlaneEnvironment, key: string) {
  const object = await storage(env).get(key);
  if (!object) throw new HttpError(404, 'Photo not found.');
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleFoodlane(request: Request, env: FoodlaneEnvironment) {
  try {
    const url = new URL(request.url);
    const [, , area, ...parts] = url.pathname.split('/');
    const path = parts.join('/');
    if (!['public', 'account', 'buyer', 'seller', 'admin'].includes(area)) throw new HttpError(404, 'Not found.');
    const origin = authOrigin(env.AUTH_BASE_URL,env.AUTH_ALLOW_LOCAL_HTTP==='true');
    if(url.origin!==origin)throw new HttpError(403,'Invalid request origin.');
    if(request.url.length>(area==='public'&&path==='catalogue'?4096:2048)||parts.some(p=>p.length>100))throw new HttpError(400,'Invalid request path.');
    const allowedQuery = area==='account'&&path==='profile-photo' ? ['v'] : area==='public'&&path==='catalogue' ? ['search','cuisines','places','collection','page','limit'] : area==='public'&&path==='sellers' ? ['lat','lng','radius','page','limit','search','location'] : area==='public'&&(/^sellers\/[^/]+$/.test(path)||/^foods\/[^/]+\/reviews$/.test(path)) ? ['page'] : area==='admin'&&path==='accounts' ? ['search','role','status','page'] : area==='admin'&&path==='audit' ? ['cursor','limit'] : area==='admin'&&path==='reports' ? ['page'] : [];
    const queryKeys=[...url.searchParams.keys()];
    if(queryKeys.some(k=>!allowedQuery.includes(k))||new Set(queryKeys).size!==queryKeys.length)throw new HttpError(400,'Invalid query parameters.');
    await rateLimit(env,'ip',request.headers.get('cf-connecting-ip')??'local-or-unknown',300,60);
    const user = area === 'public' ? null : await sessionUser(request.headers, env);
    if(user)await rateLimit(env,request.method==='GET'?'read':'write',user.userId,request.method==='GET'?240:60,60);
    if (area === 'account') requireIdentity(user);
    if (area === 'buyer' || area === 'seller' || area === 'admin') requireRole(user, area);
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    if (request.method === 'POST') {
      const origin = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
      if (url.origin !== origin || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Invalid request origin.');
    }
    const db = env.DB, now = new Date().toISOString();
    // Only the explicit MFA bootstrap endpoints are accessible before step-up.
    if (area === 'admin') {
      if (path === 'mfa/status' && request.method === 'GET') return json(await handleAdminMfa(env,user!,'status',undefined));
      if (['mfa/enroll','mfa/confirm','mfa/verify','mfa/recover'].includes(path) && request.method === 'POST') return json(await handleAdminMfa(env,user!,parts[1],await input(request)));
      await requireAdminMfa(db,user);
    }

    if (area === 'seller' && request.method === 'POST' && ['verification','photos'].includes(path)) {
      const clock = Date.now();
      const rate = await db.prepare(`INSERT INTO auth_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
        .bind(`upload:${user!.userId}`,clock+600000,clock,clock).first<{count:number}>();
      if (!rate || rate.count > 10) throw new RateLimitError(600);
    }
    if (area === 'account' && path === 'me' && request.method === 'GET') return json({ user: { name: user!.name, email: user!.email ?? null, image: user!.image?.startsWith('profile/') ? '/api/account/profile-photo' : user!.image ?? null, phone: user!.phone ?? null, role: user!.role, roleChosen: user!.roleChosen } });
    if (area === 'account' && path === 'profile-photo' && request.method === 'GET') {
      const row = await db.prepare('SELECT image FROM auth_users WHERE id=?').bind(user!.userId).first<{image:string|null}>();
      if (!row?.image || !row.image.startsWith('profile/'+user!.userId+'/') || !row.image.endsWith('.png')) throw new HttpError(404,'Photo not found.');
      return await imageResponse(env,row.image);
    }
    if (area === 'account' && ['profile','role'].includes(path) && request.method === 'POST') {
      const isRoleSetup = path === 'role';
      const dataForm = await form(request,5*1024*1024+16384);
      const name = text(100).parse(dataForm.get('name'));
      const phoneRaw = String(dataForm.get('phone') ?? '').trim();
      const phone = phoneRaw || null;
      if (phone && (!/^[+0-9 ()-]+$/.test(phone) || phone.replace(/\D/g,'').length < 7 || phone.replace(/\D/g,'').length > 15)) throw new HttpError(400,'Enter a valid mobile number.');
      const photo = dataForm.get('profilePhoto');
      const photoFile = photo instanceof File && photo.size ? photo : null;
      const removePhoto = dataForm.get('removePhoto') === 'true';
      const useGooglePhoto = dataForm.get('useGooglePhoto') === 'true';
      if (removePhoto && photoFile) throw new HttpError(400,'Choose a new photo or remove the current one.');
      if (isRoleSetup) {
        const role = z.enum(['buyer','seller']).parse(dataForm.get('role'));
        if (role === 'buyer' && !phone) throw new HttpError(400,'Add a mobile number to finish your buyer profile.');
        if (photoFile) await storeProfilePhoto(env,user!.userId,photoFile);
        const result = await db.prepare("UPDATE auth_users SET name=?,phone=?,image=CASE WHEN ?=1 OR ?=1 THEN image ELSE NULL END,role=?,role_chosen=1,updated_at=? WHERE id=? AND account_status='active' AND role_chosen=0 AND role!='admin'")
          .bind(name,phone,useGooglePhoto?1:0,photoFile?1:0,role,Date.now(),user!.userId).run();
        if (!result.meta.changes) throw new HttpError(409,'Your profile and account type have already been set.');
        return json({ok:true,role});
      }
      if (!phone) throw new HttpError(400,'Enter a mobile number.');
      const current = await db.prepare('SELECT image FROM auth_users WHERE id=?').bind(user!.userId).first<{image:string|null}>();
      if (photoFile) await storeProfilePhoto(env,user!.userId,photoFile);
      else if (removePhoto && current?.image) {
        const now = new Date().toISOString();
        await db.batch([
          db.prepare("UPDATE auth_users SET name=?,phone=?,image=NULL,updated_at=? WHERE id=? AND account_status='active'").bind(name,phone,Date.now(),user!.userId),
          ...(current.image.startsWith('profile/'+user!.userId+'/') ? [db.prepare("UPDATE verification_files SET kind='account-delete',state='deleting',delete_after=?,next_attempt_at=NULL WHERE subject=? AND object_key=? AND kind='profile-photo'").bind(now,user!.userId,current.image)] : []),
        ]);
        return json({ok:true});
      }
      await db.prepare("UPDATE auth_users SET name=?,phone=?,updated_at=? WHERE id=? AND account_status='active'").bind(name,phone,Date.now(),user!.userId).run();
      return json({ok:true});
    }
    if(area==='account'&&path==='delete'&&request.method==='POST') {
      if(user!.role==='admin')await requireAdminMfa(db,user);
      const result=await confirmDeletion(env,user!,await input(request));
      const response=json(result,result.deletionPending||result.cleanupPending||result.filesPending?202:200);
      for(const name of ['foodlane_session','foodlane_pkce','foodlane_oauth_state'])response.headers.append('Set-Cookie',name+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(origin.startsWith('https:')?'; Secure':''));
      return response;
    }
    if (area === 'public' && /^sellers\/[^/]+\/(portrait|place)$/.test(path) && request.method === 'GET') return await publicVerificationMedia(env,parts[1],parts[2]==='portrait'?'portrait':'public-place');
    if (area === 'public' && path === 'sellers' && request.method === 'GET') return json(await discoverSellers(db,url));
    if (area === 'public' && /^sellers\/[^/]+$/.test(path) && request.method === 'GET') return json(await sellerDetails(db,parts[1],url));
    if (area === 'public' && /^foods\/[^/]+\/reviews$/.test(path) && request.method === 'GET') return json(await foodReviews(db,parts[1],url));
    if (area === 'public' && path === 'catalogue' && request.method === 'GET') return json(await catalogue(db,url));
    if (area === 'public' && /^photos\/[^/]+$/.test(path) && request.method === 'GET') {
      const row = await db.prepare("SELECT f.image FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(parts[1]).first<{ image: string }>();
      if (!row) throw new HttpError(404, 'Photo not found.');
      return await imageResponse(env, row.image);
    }
    if (area === 'buyer') {
      if(path==='report'&&request.method==='POST'){await rateLimit(env,'report',user!.userId,3,86400);return json(await reportSeller(db,user!.userId,await input(request)));}
      if (path === 'interests' && request.method === 'GET') {
        const rows = await db.prepare("SELECT i.food_id FROM interests i JOIN foods f ON f.id=i.food_id JOIN sellers s ON s.id=f.seller_id WHERE i.user_id=? AND f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(user!.userId).all();
        return json({ interests: rows.results });
      }
      if (/^feedback\/[^/]+$/.test(path) && request.method === 'GET') {
        const seller = await db.prepare("SELECT id FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id)").bind(parts[1]).first();
        if (!seller) throw new HttpError(404,'Seller unavailable.');
        const recommendation = await db.prepare('SELECT 1 recommended FROM seller_recommendations WHERE seller_id=? AND user_id=?').bind(parts[1],user!.userId).first();
        return json({recommended:!!recommendation});
      }
      if (path === 'recommendation' && request.method === 'POST') {
        const data = z.object({sellerId:text(100),recommended:z.boolean()}).strict().parse(await input(request));
        const seller = await db.prepare("SELECT id FROM sellers WHERE id=? AND status='verified' AND owner!=? AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id)").bind(data.sellerId,user!.userId).first();
        if (!seller) throw new HttpError(404,'Seller unavailable.');
        if(data.recommended) {
          await db.prepare("INSERT INTO seller_recommendations(seller_id,user_id,created) SELECT id,?,? FROM sellers WHERE id=? AND status='verified' AND owner!=? AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) ON CONFLICT(seller_id,user_id) DO NOTHING").bind(user!.userId,now,data.sellerId,user!.userId).run();
        } else {
          await db.prepare('DELETE FROM seller_recommendations WHERE seller_id=? AND user_id=?').bind(data.sellerId,user!.userId).run();
        }
        return json({ok:true});
      }
      if (/^reviews\/[^/]+$/.test(path) && request.method === 'GET') {
        const review = await db.prepare("SELECT r.rating,r.body,r.created FROM reviews r JOIN foods f ON f.id=r.food_id JOIN sellers s ON s.id=f.seller_id WHERE r.food_id=? AND r.user_id=? AND f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(parts[1],user!.userId).first();
        return json({review});
      }
      if (['interest','review','review/edit'].includes(path) && request.method === 'POST') {
        const raw = await input(request);
        if (path === 'interest') {
          const data = z.object({ foodId: text(100), interested: z.boolean().default(true) }).strict().parse(raw);
          const food = await db.prepare("SELECT f.id FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) AND s.owner!=?").bind(data.foodId,user!.userId).first();
          if (!food) throw new HttpError(404,'Food unavailable.');
          if (data.interested) {
            await db.prepare("INSERT INTO interests(food_id,user_id) SELECT f.id,? FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND s.owner!=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active') AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) ON CONFLICT(food_id,user_id) DO NOTHING").bind(user!.userId,data.foodId,user!.userId).run();
          } else {
            await db.prepare('DELETE FROM interests WHERE food_id=? AND user_id=?').bind(data.foodId,user!.userId).run();
          }
          return json({ ok: true, interested: data.interested });
        }
        if (path === 'review' || path === 'review/edit') {
          const data = z.object({ foodId: text(100), rating: z.number().int().min(1).max(5), body: text(1000) }).strict().parse(raw);
          const food = await db.prepare("SELECT f.id FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND s.owner!=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active') AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id)").bind(data.foodId,user!.userId).first();
          if (!food) throw new HttpError(404,'Food unavailable.');
          const result = path === 'review'
            ? await db.prepare("INSERT INTO reviews(food_id,user_id,name,rating,body,created) SELECT f.id,?,?,?,?,? FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND s.owner!=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active') AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) ON CONFLICT(food_id,user_id) DO NOTHING").bind(user!.userId,user!.name,data.rating,data.body,now,data.foodId,user!.userId).run()
            : await db.prepare("UPDATE reviews SET name=?,rating=?,body=?,created=? WHERE food_id=? AND user_id=? AND EXISTS(SELECT 1 FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND s.owner!=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active') AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id))").bind(user!.name,data.rating,data.body,now,data.foodId,user!.userId,data.foodId,user!.userId).run();
          if (!result.meta.changes) throw new HttpError(path === 'review' ? 409 : 404,path === 'review' ? 'A review already exists or food is unavailable. Use Edit review to change your review.' : 'Review unavailable.');
          return json({ok:true});
        }
      }
    }
    if (area === 'seller') {
      const suspension=await db.prepare('SELECT x.reason,x.created FROM seller_suspensions x JOIN sellers s ON s.id=x.seller_id WHERE s.owner=?').bind(user!.userId).first();
      if(suspension&&request.method==='POST'&&path!=='portrait/withdraw')throw new HttpError(403,'Your seller account is suspended. Contact Foodlane support.');

      if (path === 'dashboard' && request.method === 'GET') {
        const seller = await db.prepare('SELECT id,name,bio,address place_label,lat,lng,hours,status,updated FROM sellers WHERE owner=?').bind(user!.userId).first<{ id: string }>();
        if (!seller) return json({ seller: null, ownFoods: [], submission: null, logs: [] });
        const foods = await db.prepare(`SELECT id,seller_id,name,description,price,category,available,
          '/api/seller/photos/' || substr(image, length('food/' || seller_id || '/') + 1, 36) AS image,
          (SELECT original_price FROM food_offers WHERE food_id=foods.id) original_price,(SELECT label FROM food_offers WHERE food_id=foods.id) offer_label,
          (SELECT COUNT(*) FROM interests i WHERE i.food_id=foods.id) interest_count,(SELECT AVG(rating) FROM reviews r WHERE r.food_id=foods.id) rating,(SELECT COUNT(*) FROM reviews r WHERE r.food_id=foods.id) review_count FROM foods WHERE seller_id=?`).bind(seller.id).all();
        const submission = await db.prepare('SELECT id,status,created,reviewed_at,decision_note FROM seller_verifications WHERE seller_id=? ORDER BY created DESC,rowid DESC LIMIT 1').bind(seller.id).first();
        const logs = await db.prepare('SELECT action,created_at AS created FROM audit_log WHERE subject=? ORDER BY created_at DESC LIMIT 100').bind(seller.id).all();
        const consent = await db.prepare('SELECT portrait_consent FROM seller_verifications WHERE seller_id=? ORDER BY created DESC LIMIT 1').bind(seller.id).first<{portrait_consent:number}>();
        const interest = await db.prepare('SELECT COUNT(DISTINCT i.user_id) total FROM interests i JOIN foods f ON f.id=i.food_id WHERE f.seller_id=?').bind(seller.id).first<{total:number}>();
        return json({ suspension, interestCount: interest?.total ?? 0, seller, ownFoods: foods.results, submission, logs: logs.results, portraitConsent: !!consent?.portrait_consent });
      }
      if (path === 'profile' && request.method === 'POST') {
        const data = profileInput.parse(await input(request));
        const seller = await db.prepare('SELECT id,name,status,address,lat,lng FROM sellers WHERE owner=?').bind(user!.userId).first<Seller>();
        if (seller) {
          const changed = data.name !== seller.name || data.address !== seller.address || data.lat !== seller.lat || data.lng !== seller.lng;
          const pending = await db.prepare("SELECT id FROM seller_verifications WHERE seller_id=? AND status='pending'").bind(seller.id).first();
          if (changed && pending) throw new HttpError(409, 'Wait for your pending review before changing identity or location.');
          await db.prepare('UPDATE sellers SET name=?,bio=?,address=?,lat=?,lng=?,hours=?,updated=?,status=? WHERE id=? AND owner=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=sellers.owner AND account_status=\'active\') AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id)')
            .bind(data.name, data.bio, data.address, data.lat, data.lng, data.hours, now, changed ? 'pending' : seller.status, seller.id, user!.userId).run();
        } else {
          await db.prepare("INSERT INTO sellers (id,owner,name,phone,bio,address,lat,lng,hours,status,updated) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_users WHERE id=? AND account_status='active')")
            .bind(crypto.randomUUID(), user!.userId, data.name, '', data.bio, data.address, data.lat, data.lng, data.hours, 'pending', now, user!.userId).run();
        }
        return json({ ok: true });
      }
      const seller = await ownSeller(db, user!);
      if (path === 'verification/reopen' && request.method === 'POST') {
        z.object({}).strict().parse(await input(request));
        const result=await db.batch([
          db.prepare("INSERT INTO audit_log(id,subject,action,created_at) SELECT ?,id,'review_requested',? FROM sellers WHERE id=? AND owner=? AND status='verified'").bind(crypto.randomUUID(),now,seller.id,user!.userId),
          db.prepare("UPDATE sellers SET status='pending',updated=? WHERE id=? AND owner=? AND status='verified'").bind(now,seller.id,user!.userId),
        ]);
        if(!result[1].meta.changes)throw new HttpError(409,'Seller already requires review.');
        return json({ok:true});
      }
      if (path === 'portrait/withdraw' && request.method === 'POST') {
        z.object({}).strict().parse(await input(request));
        await withdrawPortrait(env,seller.id); return json({ ok:true });
      }
      if (path === 'food' && request.method === 'POST') {
        approved(seller);
        const data = foodInput.parse(await input(request));
        if(data.originalPrice!=null&&data.originalPrice<=data.price)throw new HttpError(400,'The original price must exceed the offer price.');
        if(data.offerLabel&&!data.originalPrice)throw new HttpError(400,'Add an original price for this offer.');
        const foodId=data.id??crypto.randomUUID();
        if (data.id && !await db.prepare('SELECT id FROM foods WHERE id=? AND seller_id=?').bind(data.id, seller.id).first()) throw new HttpError(403, 'You can edit only your own food.');
        const match = /^\/api\/seller\/photos\/([a-f0-9-]{36})$/.exec(data.image);
        if (!match) throw new HttpError(400, 'Upload your own food photo first.');
        const key = `food/${seller.id}/${match[1]}.png`;
        if (!await storage(env).head(key)) throw new HttpError(400, 'Upload your own food photo first.');
        const allowed = "EXISTS(SELECT 1 FROM verification_files WHERE object_key=? AND subject=? AND state='attached' AND delete_after IS NULL) AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND owner=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id))";
        const change = data.id
          ? db.prepare(`UPDATE foods SET name=?,description=?,price=?,category=?,image=?,available=? WHERE id=? AND seller_id=? AND ${allowed}`)
            .bind(data.name,data.description,data.price,data.category,key,data.available?1:0,data.id,seller.id,key,seller.id,seller.id,user!.userId)
          : db.prepare(`INSERT INTO foods SELECT ?,?,?,?,?,?,?,? WHERE ${allowed}`)
            .bind(foodId,seller.id,data.name,data.description,data.price,data.category,key,data.available?1:0,key,seller.id,seller.id,user!.userId);
        const results = await db.batch([
          db.prepare("UPDATE verification_files SET state='attached',delete_after=NULL WHERE object_key=? AND subject=? AND state IN ('staging','attached') AND (delete_after IS NULL OR delete_after>?) AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND owner=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id))")
            .bind(key,seller.id,now,seller.id,user!.userId),change,
          ...(data.originalPrice!=null ? [db.prepare(`INSERT INTO food_offers(food_id,original_price,label) SELECT id,?,? FROM foods WHERE id=? AND seller_id=? AND ${allowed} ON CONFLICT(food_id) DO UPDATE SET original_price=excluded.original_price,label=excluded.label`).bind(data.originalPrice,data.offerLabel??'',foodId,seller.id,key,seller.id,seller.id,user!.userId)] : [db.prepare(`DELETE FROM food_offers WHERE food_id=? AND EXISTS(SELECT 1 FROM foods WHERE id=? AND seller_id=? AND ${allowed})`).bind(foodId,foodId,seller.id,key,seller.id,seller.id,user!.userId)]),
        ]);
        if (!results[1].meta.changes) throw new HttpError(409,'Photo or seller status changed. Upload a new photo after approval.');
        return json({ ok: true });
      }
      if (path === 'photos' && request.method === 'POST') {
        approved(seller);
        const image = (await form(request, 6 * 1024 * 1024)).get('photo');
        if (!(image instanceof File)) throw new HttpError(400, 'Upload a JPEG or PNG.');
        const bytes = await sanitizeImage(image, env.IMAGES);
        const staged = await stageFile(env,seller.id,null,'food','media',bytes);
        // Unused food uploads expire after a day; saving a listing attaches the file.
        await db.prepare("UPDATE verification_files SET delete_after=? WHERE id=? AND state='staging'").bind(new Date(Date.now()+86400000).toISOString(),staged.id).run();
        return json({ image: `/api/seller/photos/${staged.id}` });
      }
      if (/^photos\/[a-f0-9-]{36}$/.test(path) && request.method === 'GET') return await imageResponse(env, `food/${seller.id}/${parts[1]}.png`);
      if (path === 'verification' && request.method === 'POST') {
        if (seller.status === 'verified') throw new HttpError(409, 'Already approved.');
        const pending = await db.prepare("SELECT id FROM seller_verifications WHERE seller_id=? AND status='pending'").bind(seller.id).first();
        if (pending) throw new HttpError(409, 'A submission is already pending.');
        await submitVerification(env,seller.id,user!.userId,await form(request));
        return json({ ok: true });
      }
    }
    if (area === 'admin') {
      if(path==='accounts'&&request.method==='GET')return json(await accountDirectory(db,url,user!.userId));
      if(path==='accounts/decision'&&request.method==='POST'){await rateLimit(env,'account-moderation',user!.userId,30,600);const result=await accountDecision(env,user!.userId,await input(request));return json(result,'deletionPending' in result&&result.deletionPending?202:200);}
      if(path==='cleanup'&&request.method==='GET')return json(await cleanupStatus(db));
      if(path==='cleanup/retry'&&request.method==='POST'){z.object({}).strict().parse(await input(request));await rateLimit(env,'cleanup-retry',user!.userId,3,600);return json(await retryCleanup(env));}
      if(path==='reports'&&request.method==='GET')return json(await reports(db,url,user!.userId));
      if(path==='reports/decision'&&request.method==='POST')return json(await moderate(db,user!.userId,await input(request)));
      if(path==='suspensions/lift'&&request.method==='POST')return json(await liftSuspension(db,user!.userId,await input(request)));
      if (path === 'audit' && request.method === 'GET') return json(await auditHistory(env.DB,url));
      if (path === 'verifications' && request.method === 'GET') return json(await adminQueue(env));
      if (/^verifications\/[^/]+$/.test(path) && request.method === 'GET') { await requireFreshAdminMfa(db,user); return json(await adminVerificationDetails(env,parts[1],user!.userId)); }
      if (/^verifications\/[^/]+\/documents\/(identity|passport|selling)$/.test(path) && request.method === 'GET') {
        await requireFreshAdminMfa(db,user);
        const kind = { identity:'nid', passport:'passport', selling:'place' }[parts[3]]!;
        return await privateDocument(env,parts[1],kind,user!.userId);
      }
      if (path === 'decision' && request.method === 'POST') {
        const data = z.object({ id: text(100), status: z.enum(['verified','rejected']), note: text(1000), eligibility: z.enum(['adult','underage','unconfirmed']) }).strict().parse(await input(request));
        return json({ ok: true, status: await decideVerification(env,user!.userId,data) });
      }
    }
    throw new HttpError(404, 'Not found.');
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(JSON.stringify({error:error.message}),{status:429,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store','Retry-After':String(error.retryAfter)}});
    if (error instanceof AuthUnavailableError) return json({error:error.message},503);
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'Invalid fields. Check your input.' }, 400);
    console.error('FOODLANE_API_FAILED');
    return json({ error: 'Request could not be completed.' }, 503);
  }
}
