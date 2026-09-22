import { z } from 'zod';
import { HttpError } from './permissions';
const label=z.string().trim().min(1).max(100),reason=z.string().trim().min(10).max(1000);
export async function reportSeller(db:D1Database,userId:string,raw:unknown) {
  const data=z.object({sellerId:label,reason}).strict().parse(raw);
  const result=await db.prepare(`INSERT INTO seller_reports(id,seller_id,user_id,reason,created) SELECT ?,id,?,?,? FROM sellers WHERE id=? AND status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=sellers.id) ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(),userId,data.reason,new Date().toISOString(),data.sellerId).run();
  if(!result.meta.changes)throw new HttpError(409,'Seller unavailable or you already have an open report.');
  return {ok:true};
}
export async function reports(db:D1Database,url:URL,admin:string) {
  const {page}=z.object({page:z.string().regex(/^[1-9]\d{0,3}$/).transform(Number).optional().default(1)}).strict().parse(Object.fromEntries(url.searchParams));
  const rows=await db.prepare(`SELECT r.id,r.seller_id,s.name seller_name,r.reason,r.created FROM seller_reports r JOIN sellers s ON s.id=r.seller_id WHERE r.status='open' ORDER BY r.created,r.id LIMIT 26 OFFSET ?`).bind((page-1)*25).all();
  const suspensions=await db.prepare('SELECT x.seller_id,s.name seller_name,x.reason,x.created FROM seller_suspensions x JOIN sellers s ON s.id=x.seller_id ORDER BY x.created DESC LIMIT 26 OFFSET ?').bind((page-1)*25).all();
  const viewed=[...rows.results.slice(0,25).map(r=>({subject:String(r.id),action:'report_viewed'})),...suspensions.results.slice(0,25).map(s=>({subject:String(s.seller_id),action:'suspension_viewed'}))];
  if(viewed.length)await db.batch(viewed.map(v=>db.prepare('INSERT INTO audit_log(id,subject,action,admin_ref,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),v.subject,v.action,admin,new Date().toISOString())));
  return {reports:rows.results.slice(0,25),suspensions:suspensions.results.slice(0,25),hasMore:rows.results.length>25||suspensions.results.length>25,page};
}
export async function moderate(db:D1Database,admin:string,raw:unknown) {
  const data=z.object({id:label,action:z.enum(['dismiss','suspend']),reason}).strict().parse(raw);
  const token=crypto.randomUUID(),now=new Date().toISOString();
  const result=await db.batch([
    db.prepare("UPDATE seller_reports SET status=?,resolution=?,resolved_at=?,decision_id=? WHERE id=? AND status='open'").bind(data.action==='dismiss'?'dismissed':'suspended',data.reason,now,token,data.id),
    db.prepare(`INSERT INTO seller_suspensions(seller_id,reason,created) SELECT seller_id,?,? FROM seller_reports WHERE id=? AND decision_id=? AND status='suspended' ON CONFLICT DO NOTHING`).bind(data.reason,now,data.id,token),
    db.prepare("UPDATE sellers SET status='suspended',updated=? WHERE id IN (SELECT seller_id FROM seller_reports WHERE id=? AND decision_id=? AND status='suspended')").bind(now,data.id,token),
    db.prepare('INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,seller_id,?,?,? FROM seller_reports WHERE id=? AND decision_id=?').bind(crypto.randomUUID(),data.action==='dismiss'?'report_dismissed':'seller_suspended',admin,now,data.id,token),
  ]);
  if(!result[0].meta.changes)throw new HttpError(409,'Report already resolved or unavailable.');
  return {ok:true};
}
export async function liftSuspension(db:D1Database,admin:string,raw:unknown) {
  const data=z.object({sellerId:label,reason}).strict().parse(raw),now=new Date().toISOString();
  // A new verification is required. Lifting a suspension never republishes stale evidence.
  const result=await db.batch([
    db.prepare("INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,seller_id,'suspension_lifted',?,? FROM seller_suspensions WHERE seller_id=?").bind(crypto.randomUUID(),admin,now,data.sellerId),
    db.prepare("UPDATE sellers SET status='pending',updated=? WHERE id=? AND EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=?)").bind(now,data.sellerId,data.sellerId),
    db.prepare('DELETE FROM seller_suspensions WHERE seller_id=?').bind(data.sellerId),
  ]);
  if(!result[2].meta.changes)throw new HttpError(409,'Suspension already lifted or unavailable.');
  return {ok:true};
}
