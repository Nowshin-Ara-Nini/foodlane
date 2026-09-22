import type { AuthEnvironment } from './auth';
import { HttpError } from './permissions';

export class RateLimitError extends HttpError {
  constructor(public retryAfter:number) {super(429,'Too many requests. Please try again later.');}
}
export async function fingerprint(env:AuthEnvironment,value:string) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.BETTER_AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function rateLimit(env:AuthEnvironment,scope:string,identity:string,max:number,seconds:number) {
  const now=Date.now(),key=await fingerprint(env,`api:${scope}:${identity}`);
  const row=await env.DB.prepare(`INSERT INTO auth_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at`).bind(key,now+seconds*1000,now,now).first<{count:number;expires_at:number}>();
  if(!row||row.count>max)throw new RateLimitError(Math.max(1,Math.ceil(((row?.expires_at??now+60000)-now)/1000)));
}
