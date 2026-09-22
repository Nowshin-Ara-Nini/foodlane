import { z } from 'zod';
import { HttpError } from './permissions';
export async function auditHistory(db:D1Database,url:URL){
  const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),cursor:z.string().max(400).optional()}).strict().parse(Object.fromEntries(url.searchParams));
  let cursor:{time:string;id:string}|undefined;
  if(query.cursor){
    try{cursor=z.object({time:z.iso.datetime(),id:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)}).strict().parse(JSON.parse(atob(query.cursor)));}
    catch{throw new HttpError(400,'Invalid audit cursor.');}
  }
  const base='SELECT id,subject,action,admin_ref,created_at FROM audit_log';
  const statement=cursor?db.prepare(`${base} WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT ?`).bind(cursor.time,cursor.time,cursor.id,query.limit+1):db.prepare(`${base} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(query.limit+1);
  const result=await statement.all<{id:string;created_at:string}>(),hasMore=result.results.length>query.limit;
  const events=result.results.slice(0,query.limit),last=events.at(-1);
  return {events,nextCursor:hasMore&&last?btoa(JSON.stringify({time:last.created_at,id:last.id})):null};
}
