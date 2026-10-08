import { fingerprint } from './api-security';
import type { AuthEnvironment } from './auth';
import { audit, fileBucket, type PrivateEnvironment, type FileRecord } from './private-verification';
import { deleteSupabaseAccount } from './supabase-auth';

// Durable jobs are the file rows themselves. Re-running a successful R2 delete is safe.
export async function cleanupVerificationFiles(env: PrivateEnvironment, now = new Date().toISOString(), limit = 100) {
  const rows = await env.DB.prepare(`SELECT id,subject,submission_id,kind,bucket,object_key,attempts FROM verification_files
    WHERE object_key IS NOT NULL AND delete_after<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY delete_after LIMIT ?`).bind(now,now,limit).all<FileRecord>();
  let deleted = 0, failed = 0;
  for (const row of rows.results) {
    try {
      // Conditional transition prevents a stale staging job from deleting an attached file.
      const claimed = await env.DB.prepare("UPDATE verification_files SET state='deleting' WHERE id=? AND object_key=? AND delete_after<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?)")
        .bind(row.id,row.object_key,now,now).run();
      if (!claimed.meta.changes) continue;
      await fileBucket(env,row.bucket).delete(row.object_key);
      // Account deletion may have changed the kind while the R2 delete was in
      // flight. Read the current kind in the transaction, not our stale snapshot.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM verification_files WHERE id=? AND object_key=? AND kind IN ('account-delete','legacy')").bind(row.id,row.object_key),
        env.DB.prepare("UPDATE verification_files SET object_key=NULL,state='deleted',deleted_at=?,next_attempt_at=NULL WHERE id=? AND object_key=?").bind(now,row.id,row.object_key),
      ]);
      deleted++;
    } catch {
      failed++;
      // No exception text, document keys or private fields enter logs.
      const retry = new Date(Date.parse(now) + Math.min(86400000, 60000 * 2 ** Math.min(row.attempts,10))).toISOString();
      await env.DB.prepare('UPDATE verification_files SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND object_key IS NOT NULL').bind(retry,row.id).run();
    }
  }
  return { deleted, failed, scanned: rows.results.length };
}

type DeletionJob = {user_id:string;provider_required:number;provider_deleted:number;requested_by:string|null;feedback_reason:string|null;attempts:number};
export type DeletionResult = {dataDeleted:boolean;filesPending:number|null;deletionPending?:boolean;cleanupPending?:boolean};

// Revoke access and persist intent atomically before either service is changed.
export async function deleteAccountData(env: PrivateEnvironment & AuthEnvironment, userId: string, feedbackReason: string | null = null, requestedBy: string | null = null): Promise<DeletionResult> {
  const providerRequired = !!(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL);
  if (providerRequired && !env.SUPABASE_SECRET_KEY) throw new Error('Account deletion is not configured.');
  const now = Date.now();
  const queued = await env.DB.batch([
    env.DB.prepare(`INSERT INTO account_deletion_jobs(user_id,provider_required,requested_by,feedback_reason,created_at) SELECT id,?,?,?,? FROM auth_users WHERE id=? ON CONFLICT(user_id) DO NOTHING`).bind(providerRequired?1:0,requestedBy,feedbackReason,now,userId),
    env.DB.prepare("UPDATE auth_users SET account_status='deleting',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=auth_users.id)").bind(now,userId),
    env.DB.prepare("UPDATE sellers SET status='suspended',updated=? WHERE owner=? AND EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=?)").bind(new Date(now).toISOString(),userId,userId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=? AND EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=?)').bind(userId,userId),
    env.DB.prepare(`INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,id,'account_deletion_requested',?,? FROM auth_users WHERE id=? AND account_status='deleting'`).bind(crypto.randomUUID(),requestedBy,new Date(now).toISOString(),userId),
  ]);
  if (!queued[1].meta.changes) throw new Error('Account no longer available.');
  return processDeletionJob(env,userId);
}
async function processDeletionJob(env: PrivateEnvironment & AuthEnvironment,userId:string): Promise<DeletionResult> {
  const now = Date.now();
  // A bounded lease prevents cron and request retries from processing the same job.
  const job = await env.DB.prepare('UPDATE account_deletion_jobs SET next_attempt_at=? WHERE user_id=? AND next_attempt_at<=? RETURNING *').bind(now+600000,userId,now).first<DeletionJob>();
  if (!job) return {dataDeleted:false,deletionPending:true,filesPending:null};
  try {
    if (job.provider_required && !job.provider_deleted) {
      await deleteSupabaseAccount(env, userId);
      await env.DB.prepare('UPDATE account_deletion_jobs SET provider_deleted=1 WHERE user_id=?').bind(userId).run();
    }
    return await eraseLocalAccount(env,userId,job.feedback_reason,job.requested_by);
  } catch {
    await env.DB.prepare("UPDATE account_deletion_jobs SET attempts=attempts+1,next_attempt_at=?,last_error='deletion-unavailable' WHERE user_id=?").bind(now+Math.min(86400000,60000*2**Math.min(job.attempts,10)),userId).run();
    console.error('ACCOUNT_DELETION_RETRY_PENDING');
    return {dataDeleted:false,deletionPending:true,filesPending:null};
  }
}
export async function cleanupAccountDeletions(env: PrivateEnvironment & AuthEnvironment,limit=25) {
  const rows=await env.DB.prepare('SELECT user_id FROM account_deletion_jobs WHERE next_attempt_at<=? ORDER BY created_at LIMIT ?').bind(Date.now(),limit).all<{user_id:string}>();
  let completed=0,pending=0;
  for(const row of rows.results){const result=await processDeletionJob(env,row.user_id);if(result.dataDeleted)completed++;else pending++;}
  return {completed,pending,scanned:rows.results.length};
}
async function eraseLocalAccount(env: PrivateEnvironment & AuthEnvironment,userId:string,feedbackReason:string|null,requestedBy:string|null): Promise<DeletionResult> {
  const seller = await env.DB.prepare('SELECT id FROM sellers WHERE owner=?').bind(userId).first<{id:string}>();
  const now = new Date().toISOString(), subject = seller?.id ?? userId;
  const statements: D1PreparedStatement[] = [];
  if (seller) {
      statements.push(
      // Track legacy food images too, even if they predate managed uploads.
      env.DB.prepare(`INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at,delete_after)
        SELECT 'account-'||id,?,'account-delete','media',image,'deleting',?,? FROM foods WHERE seller_id=? AND image NOT IN (SELECT object_key FROM verification_files WHERE object_key IS NOT NULL)`).bind(subject,now,now,subject),
      env.DB.prepare("DELETE FROM verification_files WHERE subject=? AND object_key IS NULL").bind(subject),
      // Keep an outstanding upload's job until its bounded write window expires.
      // stageFile shortens this to now as soon as an in-flight put returns.
      env.DB.prepare("UPDATE verification_files SET kind='account-delete',submission_id=NULL,delete_after=CASE WHEN state='staging' THEN ? ELSE ? END,state='deleting',next_attempt_at=NULL WHERE subject=?")
        .bind(new Date(Date.parse(now)+3600000).toISOString(),now,subject),
      env.DB.prepare('DELETE FROM seller_verifications WHERE seller_id=?').bind(subject),
      env.DB.prepare('DELETE FROM interests WHERE food_id IN (SELECT id FROM foods WHERE seller_id=?)').bind(subject),
      env.DB.prepare('DELETE FROM reviews WHERE food_id IN (SELECT id FROM foods WHERE seller_id=?)').bind(subject),
      env.DB.prepare('DELETE FROM foods WHERE seller_id=?').bind(subject),
      env.DB.prepare('DELETE FROM sellers WHERE id=?').bind(subject),
    );
  }
  statements.push(env.DB.prepare(`INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at,delete_after) SELECT 'account-profile-'||id,id,'account-delete','media',image,'deleting',?,? FROM auth_users WHERE id=? AND image LIKE 'profile/%' AND NOT EXISTS(SELECT 1 FROM verification_files WHERE object_key=auth_users.image AND object_key IS NOT NULL)`).bind(now,now,userId));
  statements.push(env.DB.prepare("UPDATE verification_files SET kind='account-delete',submission_id=NULL,delete_after=CASE WHEN state='staging' THEN ? ELSE ? END,state='deleting',next_attempt_at=NULL WHERE subject=? AND bucket='media' AND object_key LIKE 'profile/%' AND object_key IS NOT NULL AND kind IN ('profile-photo','account-delete')").bind(new Date(Date.parse(now)+3600000).toISOString(),now,userId));
  for(const scope of ['read','write','report','delete-confirm'])statements.push(env.DB.prepare('DELETE FROM auth_limits WHERE key=?').bind(await fingerprint(env,`api:${scope}:${userId}`)));
  if(feedbackReason)statements.push(env.DB.prepare('INSERT INTO account_deletion_feedback(id,reason,created_at) VALUES(?,?,?)').bind(crypto.randomUUID(),feedbackReason,Date.now()));
  statements.push(
    env.DB.prepare('DELETE FROM interests WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM reviews WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM deletion_challenges WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_accounts WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_verifications WHERE identifier=(SELECT email FROM auth_users WHERE id=?) OR value=?').bind(userId,userId),
    env.DB.prepare('DELETE FROM auth_limits WHERE key IN (?,?)').bind(`upload:${userId}`,`admin-mfa:${userId}`),
    env.DB.prepare('DELETE FROM auth_users WHERE id=?').bind(userId),
    audit(env.DB,subject,'account_deleted',requestedBy,now),
    env.DB.prepare('DELETE FROM account_deletion_jobs WHERE user_id=?').bind(userId),
  );
  await env.DB.batch(statements);
  // A caller must report pending cleanup until no keys remain, never claim success early.
  try { await cleanupVerificationFiles(env); } catch { console.error('FILE_CLEANUP_RETRY_PENDING'); }
  try {
  const pending = await env.DB.prepare('SELECT COUNT(*) n FROM verification_files WHERE object_key IS NOT NULL AND (subject=? OR subject=?)').bind(subject,userId).first<{n:number}>();
  return { dataDeleted: true, filesPending: pending?.n ?? 0 };
  } catch { return {dataDeleted:true,filesPending:null,cleanupPending:true}; }
}
