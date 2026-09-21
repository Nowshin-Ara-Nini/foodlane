import { audit, fileBucket, type PrivateEnvironment, type FileRecord } from './private-verification';

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
      if (row.kind === 'account-delete' || row.kind === 'legacy') {
        await env.DB.prepare('DELETE FROM verification_files WHERE id=? AND object_key=?').bind(row.id,row.object_key).run();
      } else {
        await env.DB.prepare("UPDATE verification_files SET object_key=NULL,state='deleted',deleted_at=?,next_attempt_at=NULL WHERE id=? AND object_key=?").bind(now,row.id,row.object_key).run();
      }
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

// Internal primitive only. Step 6 will expose it behind reauthentication.
// Data/session revocation and enqueueing are one D1 transaction; R2 work is retryable.
export async function deleteAccountData(env: PrivateEnvironment, userId: string) {
  const seller = await env.DB.prepare('SELECT id FROM sellers WHERE owner=?').bind(userId).first<{id:string}>();
  const now = new Date().toISOString(), subject = seller?.id ?? crypto.randomUUID();
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
  statements.push(
    env.DB.prepare('DELETE FROM interests WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM reviews WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_accounts WHERE user_id=?').bind(userId),
    env.DB.prepare('DELETE FROM auth_verifications WHERE identifier=(SELECT email FROM auth_users WHERE id=?) OR value=?').bind(userId,userId),
    env.DB.prepare('DELETE FROM auth_limits WHERE key=?').bind(`upload:${userId}`),
    env.DB.prepare('DELETE FROM auth_users WHERE id=?').bind(userId),
    audit(env.DB,subject,'account_deleted',null,now),
  );
  await env.DB.batch(statements);
  // A caller must report pending cleanup until no keys remain, never claim success early.
  await cleanupVerificationFiles(env);
  const pending = await env.DB.prepare('SELECT COUNT(*) n FROM verification_files WHERE subject=? AND object_key IS NOT NULL').bind(subject).first<{n:number}>();
  return { dataDeleted: true, filesPending: pending?.n ?? 0 };
}
