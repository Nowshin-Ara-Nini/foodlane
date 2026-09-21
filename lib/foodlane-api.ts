import { z } from 'zod';
import { type AuthEnvironment } from './auth';
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

export async function handleFoodlane(request: Request, env: FoodlaneEnvironment) {
  try {
    const url = new URL(request.url);
    const [, , area, ...parts] = url.pathname.split('/');
    const path = parts.join('/');
    if (!['public', 'account', 'buyer', 'seller', 'admin'].includes(area)) throw new HttpError(404, 'Not found.');
    const user = area === 'public' ? null : await sessionUser(request.headers, env);
    if (area === 'account') requireIdentity(user);
    if (area === 'buyer' || area === 'seller' || area === 'admin') requireRole(user, area);
    if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    if (request.method === 'POST') {
      const origin = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
      if (url.origin !== origin || request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Invalid request origin.');
    }
    const db = env.DB, now = new Date().toISOString();
    if (area === 'seller' && request.method === 'POST' && ['verification','photos'].includes(path)) {
      const clock = Date.now();
      const rate = await db.prepare(`INSERT INTO auth_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
        .bind(`upload:${user!.userId}`,clock+600000,clock,clock).first<{count:number}>();
      if (!rate || rate.count > 10) throw new HttpError(429,'Too many uploads. Try again in ten minutes.');
    }
    if (area === 'account' && path === 'me' && request.method === 'GET') return json({ user: { name: user!.name, role: user!.role, roleChosen: user!.roleChosen } });
    if (area === 'account' && path === 'role' && request.method === 'POST') {
      const { role } = z.object({ role: z.enum(['buyer', 'seller']) }).strict().parse(await input(request));
      const result = await db.prepare("UPDATE auth_users SET role = ?, role_chosen = 1, updated_at = ? WHERE id = ? AND role_chosen = 0 AND role != 'admin'").bind(role, Date.now(), user!.userId).run();
      if (!result.meta.changes) throw new HttpError(409, 'Your account role has already been chosen.');
      return json({ ok: true, role });
    }
    if (area === 'public' && /^sellers\/[^/]+\/(portrait|place)$/.test(path) && request.method === 'GET') return await publicVerificationMedia(env,parts[1],parts[2]==='portrait'?'portrait':'public-place');
    if (area === 'public' && path === 'catalogue' && request.method === 'GET') {
      const foods = await db.prepare(`SELECT f.id, f.seller_id, f.name, f.description, f.price, f.category, f.available,
        '/api/public/photos/' || f.id AS image, s.name seller_name, s.bio, s.address place_label, s.lat, s.lng, s.hours, s.status, s.updated,
        (SELECT COUNT(*) FROM interests i WHERE i.food_id = f.id) interest_count,
        (SELECT AVG(rating) FROM reviews r WHERE r.food_id = f.id) rating,
        (SELECT COUNT(*) FROM reviews r WHERE r.food_id = f.id) review_count
        FROM foods f JOIN sellers s ON s.id = f.seller_id WHERE f.available = 1 AND s.status = 'verified' ORDER BY f.rowid DESC LIMIT 200`).all();
      const reviews = await db.prepare("SELECT r.food_id,r.name,r.rating,r.body,r.created FROM reviews r JOIN foods f ON f.id=r.food_id JOIN sellers s ON s.id=f.seller_id WHERE f.available=1 AND s.status='verified' ORDER BY r.created DESC LIMIT 500").all();
      return json({ foods: foods.results, reviews: reviews.results });
    }
    if (area === 'public' && /^photos\/[^/]+$/.test(path) && request.method === 'GET') {
      const row = await db.prepare("SELECT f.image FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified'").bind(parts[1]).first<{ image: string }>();
      if (!row) throw new HttpError(404, 'Photo not found.');
      return await imageResponse(env, row.image);
    }
    if (area === 'buyer') {
      if (path === 'interests' && request.method === 'GET') {
        const rows = await db.prepare("SELECT i.food_id FROM interests i JOIN foods f ON f.id=i.food_id JOIN sellers s ON s.id=f.seller_id WHERE i.user_id=? AND f.available=1 AND s.status='verified'").bind(user!.userId).all();
        return json({ interests: rows.results });
      }
      if (['interest', 'review'].includes(path) && request.method === 'POST') {
        const raw = await input(request);
        const shared = z.object({ foodId: text(100) }).parse(raw);
        const food = await db.prepare("SELECT f.id FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified' AND s.owner != ?").bind(shared.foodId, user!.userId).first();
        if (!food) throw new HttpError(404, 'Listing unavailable.');
        if (path === 'interest') {
          const data = z.object({ foodId: text(100), interested: z.boolean() }).strict().parse(raw);
          await db.prepare(data.interested ? 'INSERT OR IGNORE INTO interests VALUES (?, ?)' : 'DELETE FROM interests WHERE food_id=? AND user_id=?').bind(data.foodId, user!.userId).run();
        } else {
          const data = z.object({ foodId: text(100), rating: number(1, 5).refine(Number.isInteger), name: text(70), body: text(1000) }).strict().parse(raw);
          await db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?) ON CONFLICT(food_id,user_id) DO UPDATE SET name=excluded.name,rating=excluded.rating,body=excluded.body,created=excluded.created').bind(data.foodId, user!.userId, data.name, data.rating, data.body, now).run();
        }
        return json({ ok: true });
      }
    }
    if (area === 'seller') {
      if (path === 'dashboard' && request.method === 'GET') {
        const seller = await db.prepare('SELECT id,name,bio,address place_label,lat,lng,hours,status,updated FROM sellers WHERE owner=?').bind(user!.userId).first<{ id: string }>();
        if (!seller) return json({ seller: null, ownFoods: [], submission: null, logs: [] });
        const foods = await db.prepare(`SELECT id,seller_id,name,description,price,category,available,
          '/api/seller/photos/' || substr(image, length('food/' || seller_id || '/') + 1, 36) AS image,
          (SELECT COUNT(*) FROM interests i WHERE i.food_id=foods.id) interest_count FROM foods WHERE seller_id=?`).bind(seller.id).all();
        const submission = await db.prepare('SELECT id,status,created,reviewed_at,decision_note FROM seller_verifications WHERE seller_id=? ORDER BY created DESC,rowid DESC LIMIT 1').bind(seller.id).first();
        const logs = await db.prepare('SELECT action,created_at AS created FROM audit_log WHERE subject=? ORDER BY created_at DESC LIMIT 100').bind(seller.id).all();
        const consent = await db.prepare('SELECT portrait_consent FROM seller_verifications WHERE seller_id=? ORDER BY created DESC LIMIT 1').bind(seller.id).first<{portrait_consent:number}>();
        return json({ seller, ownFoods: foods.results, submission, logs: logs.results, portraitConsent: !!consent?.portrait_consent });
      }
      if (path === 'profile' && request.method === 'POST') {
        const data = profileInput.parse(await input(request));
        const seller = await db.prepare('SELECT id,name,status,address,lat,lng FROM sellers WHERE owner=?').bind(user!.userId).first<Seller>();
        if (seller) {
          const changed = data.name !== seller.name || data.address !== seller.address || data.lat !== seller.lat || data.lng !== seller.lng;
          const pending = await db.prepare("SELECT id FROM seller_verifications WHERE seller_id=? AND status='pending'").bind(seller.id).first();
          if (changed && pending) throw new HttpError(409, 'Wait for your pending review before changing identity or location.');
          await db.prepare('UPDATE sellers SET name=?,bio=?,address=?,lat=?,lng=?,hours=?,updated=?,status=? WHERE id=? AND owner=?')
            .bind(data.name, data.bio, data.address, data.lat, data.lng, data.hours, now, changed ? 'pending' : seller.status, seller.id, user!.userId).run();
        } else {
          await db.prepare('INSERT INTO sellers (id,owner,name,phone,bio,address,lat,lng,hours,status,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .bind(crypto.randomUUID(), user!.userId, data.name, '', data.bio, data.address, data.lat, data.lng, data.hours, 'pending', now).run();
        }
        return json({ ok: true });
      }
      const seller = await ownSeller(db, user!);
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
        const allowed = "EXISTS(SELECT 1 FROM verification_files WHERE object_key=? AND subject=? AND state='attached' AND delete_after IS NULL) AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND owner=? AND status='verified')";
        const change = data.id
          ? db.prepare(`UPDATE foods SET name=?,description=?,price=?,category=?,image=?,available=? WHERE id=? AND seller_id=? AND ${allowed}`)
            .bind(data.name,data.description,data.price,data.category,key,data.available?1:0,data.id,seller.id,key,seller.id,seller.id,user!.userId)
          : db.prepare(`INSERT INTO foods SELECT ?,?,?,?,?,?,?,? WHERE ${allowed}`)
            .bind(crypto.randomUUID(),seller.id,data.name,data.description,data.price,data.category,key,data.available?1:0,key,seller.id,seller.id,user!.userId);
        const results = await db.batch([
          db.prepare("UPDATE verification_files SET state='attached',delete_after=NULL WHERE object_key=? AND subject=? AND state IN ('staging','attached') AND (delete_after IS NULL OR delete_after>?) AND EXISTS(SELECT 1 FROM sellers WHERE id=? AND owner=? AND status='verified')")
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
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: 'Invalid fields. Check your input.' }, 400);
    console.error('FOODLANE_API_FAILED');
    return json({ error: 'Request could not be completed.' }, 503);
  }
}
