import { rateLimit, RateLimitError } from './api-security';
import { sendDeletionCode, confirmDeletion } from './account-deletion';
import { reportSeller, reports, moderate, liftSuspension } from './moderation';
import { discoverSellers, sellerDetails } from './discovery';
import { z } from 'zod';
import { handleAdminMfa, requireAdminMfa } from './admin-mfa';
import { auditHistory } from './admin-review';
import { type AuthEnvironment, type AuthMail } from './auth';
import { authOrigin } from './auth-policy';
import { HttpError, requireIdentity, requireRole, sessionUser, type AppUser } from './permissions';
import { sanitizeImage } from './image-sanitization';
import { submitVerification, adminQueue, privateDocument, decideVerification, publicVerificationMedia, withdrawPortrait, stageFile, type PrivateEnvironment } from './private-verification';

export interface FoodlaneEnvironment extends AuthEnvironment, PrivateEnvironment {}
const text = (max: number) => z.string().trim().min(1).max(max);
const number = (min: number, max: number) => z.union([z.number(), z.string().min(1)]).pipe(z.coerce.number<string | number>().finite().min(min).max(max));
const profileInput = z.object({ name: text(100), bio: text(700), address: text(250), hours: text(150), lat: number(-90, 90), lng: number(-180, 180) }).strict();
const foodInput = z.object({ id: text(100).optional(), name: text(120), description: text(700), category: text(50), price: number(1, 100000), image: text(250), available: z.boolean() }).strict();
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
async function imageResponse(env: FoodlaneEnvironment, key: string) {
  const object = await storage(env).get(key);
  if (!object) throw new HttpError(404, 'Photo not found.');
  return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleFoodlane(request: Request, env: FoodlaneEnvironment, sendMail?: (mail:AuthMail)=>Promise<void>) {
  try {
    const url = new URL(request.url);
    const [, , area, ...parts] = url.pathname.split('/');
    const path = parts.join('/');
    if (!['public', 'account', 'buyer', 'seller', 'admin'].includes(area)) throw new HttpError(404, 'Not found.');
    const origin = authOrigin(env.AUTH_BASE_URL,env.AUTH_ALLOW_LOCAL_HTTP==='true');
    if(url.origin!==origin)throw new HttpError(403,'Invalid request origin.');
    if(request.url.length>2048||parts.some(p=>p.length>100))throw new HttpError(400,'Invalid request path.');
    const allowedQuery = area==='public'&&path==='sellers' ? ['lat','lng','radius','page','limit'] : area==='public'&&/^sellers\/[^/]+$/.test(path) ? ['page'] : area==='admin'&&path==='audit' ? ['cursor','limit'] : area==='admin'&&path==='reports' ? ['page'] : [];
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
    if (area === 'account' && path === 'me' && request.method === 'GET') return json({ user: { name: user!.name, role: user!.role, roleChosen: user!.roleChosen } });
    if(area==='account'&&['deletion-code','delete'].includes(path)&&request.method==='POST') {
      if(user!.role==='admin')await requireAdminMfa(db,user);
      const raw=await input(request);
      if(path==='deletion-code'){z.object({}).strict().parse(raw);return json(await sendDeletionCode(env,user!,sendMail));}
      const result=await confirmDeletion(env,user!,raw);
      const response=json(result,result.filesPending?202:200);
      for(const name of ['better-auth.session_token','__Secure-better-auth.session_token','better-auth.session_data','__Secure-better-auth.session_data'])response.headers.append('Set-Cookie',`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${origin.startsWith('https:')?'; Secure':''}`);
      return response;
    }
    if (area === 'account' && path === 'role' && request.method === 'POST') {
      const { role } = z.object({ role: z.enum(['buyer', 'seller']) }).strict().parse(await input(request));
      const result = await db.prepare("UPDATE auth_users SET role = ?, role_chosen = 1, updated_at = ? WHERE id = ? AND role_chosen = 0 AND role != 'admin'").bind(role, Date.now(), user!.userId).run();
      if (!result.meta.changes) throw new HttpError(409, 'Your account role has already been chosen.');
      return json({ ok: true, role });
    }
    if (area === 'public' && /^sellers\/[^/]+\/(portrait|place)$/.test(path) && request.method === 'GET') return await publicVerificationMedia(env,parts[1],parts[2]==='portrait'?'portrait':'public-place');
    if (area === 'public' && path === 'sellers' && request.method === 'GET') return json(await discoverSellers(db,url));
    if (area === 'public' && /^sellers\/[^/]+$/.test(path) && request.method === 'GET') return json(await sellerDetails(db,parts[1],url));
    if (area === 'public' && path === 'catalogue' && request.method === 'GET') {
      const foods = await db.prepare(`SELECT f.id, f.seller_id, f.name, f.description, f.price, f.category, f.available,
        '/api/public/photos/' || f.id AS image, s.name seller_name, s.bio, s.address place_label, s.lat, s.lng, s.hours, s.status, s.updated,
        (SELECT COUNT(*) FROM seller_interests i WHERE i.seller_id = s.id) interest_count,
        (SELECT AVG(rating) FROM seller_reviews r WHERE r.seller_id = s.id) rating,
        (SELECT COUNT(*) FROM seller_reviews r WHERE r.seller_id = s.id) review_count
        FROM foods f JOIN sellers s ON s.id = f.seller_id WHERE f.available = 1 AND s.status = 'verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id) ORDER BY f.rowid DESC LIMIT 200`).all();
      const reviews = await db.prepare("SELECT r.seller_id,r.name,r.rating,r.body,r.created FROM seller_reviews r JOIN sellers s ON s.id=r.seller_id WHERE s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id) ORDER BY r.created DESC LIMIT 500").all();
      return json({ foods: foods.results, reviews: reviews.results });
    }
    if (area === 'public' && /^photos\/[^/]+$/.test(path) && request.method === 'GET') {
      const row = await db.prepare("SELECT f.image FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(parts[1]).first<{ image: string }>();
      if (!row) throw new HttpError(404, 'Photo not found.');
      return await imageResponse(env, row.image);
    }
    if (area === 'buyer') {
      if(path==='report'&&request.method==='POST'){await rateLimit(env,'report',user!.userId,3,86400);return json(await reportSeller(db,user!.userId,await input(request)));}
      if (path === 'interests' && request.method === 'GET') {
        const rows = await db.prepare("SELECT i.seller_id FROM seller_interests i JOIN sellers s ON s.id=i.seller_id WHERE i.user_id=? AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(user!.userId).all();
        return json({ interests: rows.results });
      }
      if (/^reviews\/[^/]+$/.test(path) && request.method === 'GET') {
        const review = await db.prepare("SELECT r.rating,r.body,r.created,r.updated FROM seller_reviews r JOIN sellers s ON s.id=r.seller_id WHERE r.seller_id=? AND r.user_id=? AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)").bind(parts[1],user!.userId).first();
        return json({review});
      }
      if (['interest','review','review/edit'].includes(path) && request.method === 'POST') {
        const raw = await input(request);
        const shared = z.object({ sellerId: text(100) }).parse(raw);
        const seller = await db.prepare("SELECT id FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) AND owner!=?").bind(shared.sellerId,user!.userId).first();
        if (!seller) throw new HttpError(404,'Seller unavailable.');
        if (path === 'interest') {
          const data = z.object({ sellerId: text(100) }).strict().parse(raw);
          // The unique pair makes retries and concurrent clicks idempotent.
          await db.prepare("INSERT INTO seller_interests(seller_id,user_id,created) SELECT id,?,? FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) ON CONFLICT(seller_id,user_id) DO NOTHING").bind(user!.userId,now,data.sellerId).run();
        } else {
          const data = z.object({ sellerId: text(100), rating: z.number().int().min(1).max(5), body: text(1000) }).strict().parse(raw);
          const result = path === 'review'
            ? await db.prepare("INSERT INTO seller_reviews(seller_id,user_id,name,rating,body,created,updated) SELECT id,?,?,?,?,?,? FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) ON CONFLICT(seller_id,user_id) DO NOTHING").bind(user!.userId,user!.name,data.rating,data.body,now,now,data.sellerId).run()
            : await db.prepare("UPDATE seller_reviews SET name=?,rating=?,body=?,updated=? WHERE seller_id=? AND user_id=? AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id))").bind(user!.name,data.rating,data.body,now,data.sellerId,user!.userId,data.sellerId).run();
          if (!result.meta.changes) throw new HttpError(path === 'review' ? 409 : 404,path === 'review' ? 'A review already exists or seller is unavailable. Use Edit review to change your review.' : 'Review unavailable.');
        }
        return json({ ok: true });
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
          (SELECT COUNT(*) FROM seller_interests i WHERE i.seller_id=foods.seller_id) interest_count FROM foods WHERE seller_id=?`).bind(seller.id).all();
        const submission = await db.prepare('SELECT id,status,created,reviewed_at,decision_note FROM seller_verifications WHERE seller_id=? ORDER BY created DESC,rowid DESC LIMIT 1').bind(seller.id).first();
        const logs = await db.prepare('SELECT action,created_at AS created FROM audit_log WHERE subject=? ORDER BY created_at DESC LIMIT 100').bind(seller.id).all();
        const consent = await db.prepare('SELECT portrait_consent FROM seller_verifications WHERE seller_id=? ORDER BY created DESC LIMIT 1').bind(seller.id).first<{portrait_consent:number}>();
        const interest = await db.prepare('SELECT COUNT(*) total FROM seller_interests WHERE seller_id=?').bind(seller.id).first<{total:number}>();
        return json({ suspension, interestCount: interest?.total ?? 0, seller, ownFoods: foods.results, submission, logs: logs.results, portraitConsent: !!consent?.portrait_consent });
      }
      if (path === 'profile' && request.method === 'POST') {
        const data = profileInput.parse(await input(request));
        const seller = await db.prepare('SELECT id,name,status,address,lat,lng FROM sellers WHERE owner=?').bind(user!.userId).first<Seller>();
        if (seller) {
          const changed = data.name !== seller.name || data.address !== seller.address || data.lat !== seller.lat || data.lng !== seller.lng;
          const pending = await db.prepare("SELECT id FROM seller_verifications WHERE seller_id=? AND status='pending'").bind(seller.id).first();
          if (changed && pending) throw new HttpError(409, 'Wait for your pending review before changing identity or location.');
          await db.prepare('UPDATE sellers SET name=?,bio=?,address=?,lat=?,lng=?,hours=?,updated=?,status=? WHERE id=? AND owner=? AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id)')
            .bind(data.name, data.bio, data.address, data.lat, data.lng, data.hours, now, changed ? 'pending' : seller.status, seller.id, user!.userId).run();
        } else {
          await db.prepare('INSERT INTO sellers (id,owner,name,phone,bio,address,lat,lng,hours,status,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .bind(crypto.randomUUID(), user!.userId, data.name, '', data.bio, data.address, data.lat, data.lng, data.hours, 'pending', now).run();
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
            .bind(crypto.randomUUID(),seller.id,data.name,data.description,data.price,data.category,key,data.available?1:0,key,seller.id,seller.id,user!.userId);
        const results = await db.batch([
          db.prepare("UPDATE verification_files SET state='attached',delete_after=NULL WHERE object_key=? AND subject=? AND state IN ('staging','attached') AND (delete_after IS NULL OR delete_after>?) AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND owner=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id))")
            .bind(key,seller.id,now,seller.id,user!.userId),change,
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
      if(path==='reports'&&request.method==='GET')return json(await reports(db,url,user!.userId));
      if(path==='reports/decision'&&request.method==='POST')return json(await moderate(db,user!.userId,await input(request)));
      if(path==='suspensions/lift'&&request.method==='POST')return json(await liftSuspension(db,user!.userId,await input(request)));
      if (path === 'audit' && request.method === 'GET') return json(await auditHistory(env.DB,url));
      if (path === 'verifications' && request.method === 'GET') return json(await adminQueue(env,user!.userId));
      if (/^verifications\/[^/]+\/documents\/(identity|passport|selling)$/.test(path) && request.method === 'GET') {
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
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'Invalid fields. Check your input.' }, 400);
    console.error('FOODLANE_API_FAILED');
    return json({ error: 'Request could not be completed.' }, 503);
  }
}
