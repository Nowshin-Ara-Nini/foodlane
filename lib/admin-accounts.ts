import { z } from 'zod';
import { HttpError } from './permissions';
import type { FoodlaneEnvironment } from './foodlane-api';
import { deleteAccountData, cleanupAccountDeletions, cleanupVerificationFiles, scrubReviewedVerificationDetails } from './verification-retention';

const id=z.string().min(1).max(100),reason=z.string().trim().min(10).max(1000);
export async function accountDirectory(db:D1Database,url:URL,admin:string) {
  const q=z.object({search:z.string().trim().max(100).default(''),role:z.enum(['all','buyer','seller']).default('all'),status:z.enum(['all','active','banned','deleting']).default('all'),page:z.coerce.number().int().min(1).max(10000).default(1)}).strict().parse(Object.fromEntries(url.searchParams));
  const filter="u.role IN ('buyer','seller') AND (?='all' OR u.role=?) AND (?='all' OR u.account_status=?) AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0 OR instr(lower(COALESCE(s.name,'')),lower(?))>0)";
  const args=[q.role,q.role,q.status,q.status,q.search,q.search,q.search,q.search];
  const rows=await db.prepare(`SELECT u.id,u.name,u.email,u.role,u.role_chosen,u.account_status,u.ban_reason,u.banned_at,u.created_at,s.id seller_id,s.name seller_name,s.status seller_status FROM auth_users u LEFT JOIN sellers s ON s.owner=u.id WHERE ${filter} ORDER BY u.created_at DESC,u.id LIMIT 26 OFFSET ?`).bind(...args,(q.page-1)*25).all();
  const total=await db.prepare(`SELECT COUNT(*) total FROM auth_users u LEFT JOIN sellers s ON s.owner=u.id WHERE ${filter}`).bind(...args).first<{total:number}>();
  await db.prepare("INSERT INTO audit_log(id,subject,action,admin_ref,created_at) VALUES(?,'account-directory','accounts_viewed',?,?)").bind(crypto.randomUUID(),admin,new Date().toISOString()).run();
  return {accounts:rows.results.slice(0,25),hasMore:rows.results.length>25,total:total?.total??0,page:q.page};
}
export async function accountDecision(env:FoodlaneEnvironment,admin:string,raw:unknown) {
  const data=z.object({userId:id,action:z.enum(['ban','unban','delete']),reason,confirmation:z.string().optional()}).strict().parse(raw);
  if(data.userId===admin)throw new HttpError(400,'You cannot moderate your own account.');
  const target=await env.DB.prepare("SELECT id,role,account_status FROM auth_users WHERE id=? AND role IN ('buyer','seller')").bind(data.userId).first<{id:string;role:string;account_status:string}>();
  if(!target)throw new HttpError(404,'Buyer or seller account unavailable.');
  if(target.account_status==='deleting')throw new HttpError(409,'Account deletion is already in progress.');
  if(data.action==='delete') {
    if(data.confirmation!=='DELETE '+target.id)throw new HttpError(400,'Confirm the exact account reference before deletion.');
    // Free-text moderation reasons must not survive personal-data deletion.
    const result=await deleteAccountData(env,target.id,null,admin);
    return {...result,ok:true};
  }
  const banning=data.action==='ban',now=Date.now();
  const changed=await env.DB.batch([
    env.DB.prepare("UPDATE auth_users SET account_status=?,ban_reason=?,banned_at=?,banned_by=?,updated_at=? WHERE id=? AND role IN ('buyer','seller') AND account_status=?")
      .bind(banning?'banned':'active',banning?data.reason:null,banning?now:null,banning?admin:null,now,target.id,banning?'active':'banned'),
    env.DB.prepare("UPDATE sellers SET status=CASE WHEN EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) THEN 'suspended' ELSE ? END,updated=? WHERE owner=? AND EXISTS(SELECT 1 FROM auth_users WHERE id=? AND account_status=?)")
      .bind(banning?'suspended':'pending',new Date(now).toISOString(),target.id,target.id,banning?'banned':'active'),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(target.id),
    env.DB.prepare("INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,id,?,?,? FROM auth_users WHERE id=? AND account_status=?")
      .bind(crypto.randomUUID(),banning?'account_banned':'account_unbanned',admin,new Date(now).toISOString(),target.id,banning?'banned':'active'),
  ]);
  if(!changed[0].meta.changes)throw new HttpError(409,'Account status changed. Refresh and try again.');
  return {ok:true};
}
export async function cleanupStatus(db:D1Database) {
  const [health,accounts,files,verificationDetails]=await Promise.all([
    db.prepare("SELECT started_at,completed_at,failed_at,files_pending,accounts_pending FROM cleanup_health WHERE id='cleanup'").first(),
    db.prepare('SELECT COUNT(*) pending,COALESCE(SUM(attempts>0),0) retrying,MIN(created_at) oldest FROM account_deletion_jobs').first(),
    db.prepare('SELECT COUNT(*) pending,COALESCE(SUM(attempts>0),0) retrying FROM verification_files WHERE object_key IS NOT NULL AND delete_after IS NOT NULL').first(),
    db.prepare('SELECT COUNT(*) pending FROM seller_verifications WHERE reviewed_at IS NOT NULL AND review_details_purged_at IS NULL').first(),
  ]);
  return {health,accounts,files,verificationDetails};
}
export async function retryCleanup(env:FoodlaneEnvironment) {
  const verificationDetails=await scrubReviewedVerificationDetails(env),accounts=await cleanupAccountDeletions(env),files=await cleanupVerificationFiles(env);
  return {processed:{verificationDetails,accounts,files},...await cleanupStatus(env.DB)};
}
