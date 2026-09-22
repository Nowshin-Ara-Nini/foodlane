import { verificationFields } from '../app/verification-validation';
import { HttpError } from './permissions';
import { encryptNid, decryptNid, type EncryptionEnvironment } from './nid-crypto';
import { sanitizeImage } from './image-sanitization';

export const LOCATION_NOTICE_VERSION = '2026-09-21-v1';
export interface PrivateEnvironment extends EncryptionEnvironment {
  DB: D1Database; BUCKET?: R2Bucket; PRIVATE_VERIFICATIONS?: R2Bucket; IMAGES?: ImagesBinding;
  VERIFICATION_RETENTION_ENABLED?: string; VERIFICATION_RETENTION_DAYS?: string;
}
export type FileRecord = { id: string; object_key: string; bucket: string; kind: string; subject: string; submission_id: string | null; attempts: number };
export function fileBucket(env: PrivateEnvironment, name: string) {
  const bucket = name === 'private' ? env.PRIVATE_VERIFICATIONS : name === 'media' ? env.BUCKET : undefined;
  if (!bucket) throw new HttpError(503, 'Verification storage is unavailable.');
  return bucket;
}
export function audit(db: D1Database, subject: string, action: string, admin: string | null, now = new Date().toISOString()) {
  return db.prepare('INSERT INTO audit_log (id,subject,action,admin_ref,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), subject, action, admin, now);
}
export function retentionDue(env: PrivateEnvironment, decisionTime: string) {
  if (env.VERIFICATION_RETENTION_ENABLED === 'false') return null;
  const days = Number(env.VERIFICATION_RETENTION_DAYS ?? '30');
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(503, 'Invalid retention configuration.');
  return new Date(Date.parse(decisionTime) + days * 86400000).toISOString();
}
export async function stageFile(env: PrivateEnvironment, subject: string, submission: string | null, kind: string, bucket: 'private' | 'media', bytes: Uint8Array) {
  const id = crypto.randomUUID(), key = `${kind}/${subject}/${id}.png`, now = new Date();
  const inserted = await env.DB.prepare('INSERT INTO verification_files (id,subject,submission_id,kind,bucket,object_key,state,created_at,delete_after) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sellers WHERE id=?)')
    .bind(id, subject, submission, kind, bucket, key, 'staging', now.toISOString(), new Date(now.getTime() + 3600000).toISOString(),subject).run();
  if (!inserted.meta.changes) throw new HttpError(409,'Account no longer available.');
  await fileBucket(env, bucket).put(key, bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' } });
  // Deletion can race an in-flight put. Recreate a durable job if cleanup already
  // removed its row, then delete the late write. There is never a serving path.
  const active = await env.DB.prepare("SELECT id FROM verification_files WHERE id=? AND state='staging' AND EXISTS(SELECT 1 FROM sellers WHERE id=?)").bind(id,subject).first();
  if (!active) {
    await env.DB.prepare("INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at,delete_after) VALUES(?,?,'account-delete',?,?,'deleting',?,?) ON CONFLICT(id) DO UPDATE SET state='deleting',delete_after=excluded.delete_after,object_key=excluded.object_key")
      .bind(id,subject,bucket,key,now.toISOString(),now.toISOString()).run();
    throw new HttpError(409,'Upload cancelled because the account changed.');
  }
  return { id, key };
}
export async function submitVerification(env: PrivateEnvironment, sellerId: string, userId: string, form: FormData) {
  let data: ReturnType<typeof verificationFields>;
  try { data = verificationFields(form); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid verification details.'); }
  if (form.get('locationConsent') !== 'on') throw new HttpError(400, 'Confirm that your selling-place label, pin and photo will become public after approval.');
  if (form.has('portraitConsent') && form.get('portraitConsent') !== 'on') throw new HttpError(400, 'Invalid portrait consent.');
  const consent = form.get('portraitConsent') === 'on', id = crypto.randomUUID(), now = new Date().toISOString();
  const encrypted = await encryptNid(env, data.nidNumber, id);
  fileBucket(env, 'private');
  // Validate and sanitize every image before any storage write. Eligibility ran first.
  const clean: { kind: string; bytes: Uint8Array }[] = [];
  for (const [field, kind] of [['identity', 'nid'], ['passport', 'passport'], ['selling', 'place']]) {
    const file = form.get(field);
    if (!(file instanceof File)) throw new HttpError(400, 'Upload all three verification photos.');
    clean.push({ kind, bytes: await sanitizeImage(file, env.IMAGES) });
  }
  const files: string[] = [];
  try {
    for (const item of clean) files.push((await stageFile(env, sellerId, id, item.kind, 'private', item.bytes)).id);
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO seller_verifications
        (id,seller_id,legal_name,age,gender,personal_email,personal_phone,home_address,nid_ciphertext,nid_iv,nid_key_version,place_address,place_lat,place_lng,note,status,created,location_notice_version,location_accepted_at,portrait_consent,portrait_consent_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM sellers JOIN auth_users ON auth_users.id=sellers.owner WHERE sellers.id=? AND sellers.owner=? AND sellers.status!='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id))`)
        .bind(id,sellerId,data.legalName,data.age,data.gender,data.personalEmail,data.personalPhone,data.homeAddress,encrypted.ciphertext,encrypted.iv,encrypted.version,data.placeAddress,data.placeLat,data.placeLng,data.note,now,LOCATION_NOTICE_VERSION,now,consent?1:0,consent?now:null,sellerId,userId),
      env.DB.prepare("UPDATE verification_files SET state='attached',delete_after=NULL WHERE submission_id=? AND state='staging' AND EXISTS (SELECT 1 FROM seller_verifications WHERE id=?)").bind(id,id),
      env.DB.prepare("UPDATE sellers SET status='pending' WHERE id=? AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) AND EXISTS (SELECT 1 FROM seller_verifications WHERE id=?)").bind(sellerId,id),
      env.DB.prepare("INSERT INTO audit_log (id,subject,action,created_at) SELECT ?,seller_id,'submitted',? FROM seller_verifications WHERE id=?").bind(crypto.randomUUID(),now,id),
    ]);
    if (!result[0].meta.changes) throw new HttpError(409, 'Account or submission changed. Please refresh.');
  } catch {
    // Keep durable staging jobs until deletion actually succeeds, including uncertain R2 writes.
    if (files.length) await env.DB.prepare("UPDATE verification_files SET delete_after=? WHERE submission_id=? AND state='staging'").bind(now,id).run();
    throw new HttpError(409, 'Unable to submit. Check whether a submission is already pending.');
  }
}

export async function adminQueue(env: PrivateEnvironment, adminId: string) {
  const queue = await env.DB.prepare(`SELECT v.id,v.seller_id,v.legal_name,v.age,v.gender,v.personal_email,v.personal_phone,v.home_address,v.place_address,v.place_lat,v.place_lng,v.note,v.status,v.created,v.nid_ciphertext,v.nid_iv,v.nid_key_version,v.portrait_consent,s.name seller_name,
    EXISTS(SELECT 1 FROM verification_files WHERE submission_id=v.id AND kind='nid' AND state='attached') has_identity,
    EXISTS(SELECT 1 FROM verification_files WHERE submission_id=v.id AND kind='passport' AND state='attached') has_passport,
    EXISTS(SELECT 1 FROM verification_files WHERE submission_id=v.id AND kind='place' AND state='attached') has_selling
    FROM seller_verifications v JOIN sellers s ON s.id=v.seller_id WHERE v.status='pending' ORDER BY v.created LIMIT 100`).all<{ id: string; seller_id: string; nid_ciphertext: string; nid_iv: string; nid_key_version: string }>();
  if (queue.results.length) await env.DB.batch(queue.results.map(v => audit(env.DB,v.seller_id,'verification_viewed',adminId)));
  const safe = [];
  for (const record of queue.results) {
    const nid = await decryptNid(env, record);
    const { nid_ciphertext: _ciphertext, nid_iv: _iv, nid_key_version: _version, ...details } = record;
    void _ciphertext; void _iv; void _version;
    safe.push({ ...details, nid_number: nid });
  }
  const history = await env.DB.prepare("SELECT v.id,v.status,v.reviewed_at,v.decision_note,s.name seller_name FROM seller_verifications v JOIN sellers s ON s.id=v.seller_id WHERE v.status!='pending' ORDER BY v.reviewed_at DESC LIMIT 100").all();
  return { queue: safe, reviewHistory: history.results };
}
export async function privateDocument(env: PrivateEnvironment, id: string, kind: string, adminId: string) {
  const row = await env.DB.prepare(`SELECT f.id,f.subject,f.object_key,f.bucket FROM verification_files f
    JOIN seller_verifications v ON v.id=f.submission_id JOIN sellers s ON s.id=v.seller_id
    WHERE v.id=? AND f.kind=? AND f.bucket='private' AND f.state='attached' AND (f.delete_after IS NULL OR f.delete_after>?)`)
    .bind(id,kind,new Date().toISOString()).first<FileRecord>();
  if (!row) throw new HttpError(404, 'Document not found or retention period ended.');
  await audit(env.DB,row.subject,'document_viewed',adminId).run();
  const object = await fileBucket(env,'private').get(row.object_key);
  if (!object) throw new HttpError(404, 'Document not found.');
  return mediaResponse(object);
}
export function mediaResponse(object: R2ObjectBody) {
  return new Response(object.body, { headers: { 'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; sandbox" } });
}
export async function publicVerificationMedia(env: PrivateEnvironment, sellerId: string, kind: 'portrait' | 'public-place') {
  const row = await env.DB.prepare(`SELECT f.object_key FROM verification_files f JOIN seller_verifications v ON v.id=f.submission_id JOIN sellers s ON s.id=v.seller_id
    WHERE s.id=? AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id) AND v.status='verified' AND f.kind=? AND f.bucket='media' AND f.state='attached'
    AND f.delete_after IS NULL AND (?!='portrait' OR (v.portrait_consent=1 AND v.portrait_withdrawn_at IS NULL)) ORDER BY v.reviewed_at DESC LIMIT 1`)
    .bind(sellerId,kind,kind).first<{ object_key: string }>();
  if (!row) throw new HttpError(404, 'Photo unavailable.');
  const object = await fileBucket(env,'media').get(row.object_key);
  if (!object) throw new HttpError(404, 'Photo unavailable.');
  return mediaResponse(object);
}
export async function withdrawPortrait(env: PrivateEnvironment, sellerId: string) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE seller_verifications SET portrait_consent=0,portrait_withdrawn_at=? WHERE seller_id=?').bind(now,sellerId),
    env.DB.prepare("UPDATE verification_files SET state='deleting',delete_after=?,next_attempt_at=NULL WHERE subject=? AND kind='portrait' AND deleted_at IS NULL").bind(now,sellerId),
    audit(env.DB,sellerId,'portrait_withdrawn',null,now),
  ]);
}
export async function decideVerification(env: PrivateEnvironment, adminId: string, data: { id: string; status: 'verified'|'rejected'; note: string; eligibility: 'adult'|'underage'|'unconfirmed' }) {
  const v = await env.DB.prepare("SELECT id,seller_id,age,portrait_consent FROM seller_verifications WHERE id=? AND status='pending'").bind(data.id).first<{ id: string; seller_id: string; age: number; portrait_consent: number }>();
  if (!v) throw new HttpError(409, 'This submission has already been reviewed or is unavailable.');
  const underage = data.eligibility === 'underage' || v.age < 18, status = underage ? 'rejected' : data.status;
  if (status === 'verified' && data.eligibility !== 'adult') throw new HttpError(400, 'Confirm the applicant is at least 18 from their evidence before approval.');
  const decision = crypto.randomUUID(), now = new Date().toISOString(), due = retentionDue(env,now);
  const staged: string[] = [];
  if (status === 'verified') {
    for (const [source, target] of [['place','public-place'], ...(v.portrait_consent ? [['passport','portrait']] : [])]) {
      const row = await env.DB.prepare("SELECT object_key FROM verification_files WHERE submission_id=? AND kind=? AND state='attached' AND bucket='private'").bind(v.id,source).first<{object_key:string}>();
      if (!row) throw new HttpError(409, 'Required document unavailable.');
      const object = await fileBucket(env,'private').get(row.object_key);
      if (!object) throw new HttpError(409, 'Required document unavailable.');
      // Re-sanitize published copies too; the private document is never exposed.
      const bytes = await sanitizeImage(new File([await object.arrayBuffer()], 'copy.png', { type:'image/png' }),env.IMAGES);
      staged.push((await stageFile(env,v.seller_id,v.id,target,'media',bytes)).id);
    }
  }
  const statements = [
    env.DB.prepare("UPDATE seller_verifications SET status=?,reviewed_by=?,reviewed_at=?,decision_note=?,decision_id=?,retention_due_at=? WHERE id=? AND status='pending'")
      .bind(status,adminId,now,underage?'Applicants must be at least 18 years old.':data.note,decision,due,v.id),
    env.DB.prepare(`UPDATE sellers SET status=CASE WHEN EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) THEN 'suspended' ELSE ? END,updated=?,address=(SELECT place_address FROM seller_verifications WHERE id=?),lat=(SELECT place_lat FROM seller_verifications WHERE id=?),lng=(SELECT place_lng FROM seller_verifications WHERE id=?) WHERE id=? AND EXISTS (SELECT 1 FROM seller_verifications WHERE id=? AND decision_id=?)`)
      .bind(status,now,v.id,v.id,v.id,v.seller_id,v.id,decision),
    env.DB.prepare(`UPDATE verification_files SET delete_after=? WHERE submission_id=? AND state='attached' AND (?='rejected' OR kind='nid') AND EXISTS (SELECT 1 FROM seller_verifications WHERE id=? AND decision_id=?)`).bind(due,v.id,status,v.id,decision),
    env.DB.prepare(`INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,seller_id,?,?,? FROM seller_verifications WHERE id=? AND decision_id=?`).bind(crypto.randomUUID(),status,adminId,now,v.id,decision),
    // Superseded public copies must not be served after renewed review.
    env.DB.prepare("UPDATE verification_files SET state='deleting',delete_after=?,next_attempt_at=NULL WHERE subject=? AND submission_id!=? AND kind IN ('portrait','public-place') AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM seller_verifications WHERE id=? AND decision_id=?)").bind(now,v.seller_id,v.id,v.id,decision),
  ];
  for (const id of staged) statements.push(env.DB.prepare(`UPDATE verification_files SET state='attached',delete_after=NULL WHERE id=? AND state='staging' AND EXISTS (SELECT 1 FROM seller_verifications WHERE id=? AND decision_id=? AND (verification_files.kind!='portrait' OR portrait_consent=1))`).bind(id,v.id,decision));
  const result = await env.DB.batch(statements);
  if (!result[0].meta.changes) throw new HttpError(409, 'This submission has already been reviewed.');
  return status;
}
