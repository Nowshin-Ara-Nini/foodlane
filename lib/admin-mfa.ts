import { symmetricEncrypt, symmetricDecrypt, constantTimeEqual } from 'better-auth/crypto';
import { z } from 'zod';
import type { AuthEnvironment } from './auth';
import { digestToken } from './auth-policy';
import { HttpError, requireRole, type AppUser } from './permissions';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes:Uint8Array) {
  let bits=0,value=0,result='';
  for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];}}
  if(bits)result+=alphabet[(value<<(5-bits))&31];return result;
}
function unbase32(secret:string){let bits=0,value=0;const bytes:number[]=[];for(const c of secret){const digit=alphabet.indexOf(c);if(digit<0)throw Error('Invalid TOTP secret');value=(value<<5)|digit;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}return new Uint8Array(bytes);}
// RFC 4226/6238: HMAC-SHA1, six digits, 30-second period. Also tested with RFC vectors.
export async function totp(secret:string,counter:number,digits=6){
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,BigInt(counter));
  const key=await crypto.subtle.importKey('raw',unbase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const h=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),offset=h[h.length-1]&15;
  const value=((h[offset]&127)<<24)|(h[offset+1]<<16)|(h[offset+2]<<8)|h[offset+3];
  return String(value%10**digits).padStart(digits,'0');
}
type Factor={secret:string;enabled:number;setup_session:string;setup_expires:number;last_counter:number};
export async function adminMfaVerified(db:D1Database,user:AppUser){
  if(user.role!=='admin')return false;
  return !!await db.prepare(`SELECT m.session_id FROM admin_mfa_sessions m JOIN admin_mfa f ON f.user_id=m.user_id JOIN auth_sessions s ON s.id=m.session_id JOIN auth_users u ON u.id=m.user_id
    WHERE m.session_id=? AND m.user_id=? AND m.expires_at>? AND s.expires_at>? AND f.enabled=1 AND u.role='admin' AND u.email_verified=1`).bind(user.sessionId,user.userId,Date.now(),Date.now()).first();
}
export async function requireAdminMfa(db:D1Database,user:AppUser|null){
  const admin=requireRole(user,'admin');
  if(!await adminMfaVerified(db,admin))throw new HttpError(403,'Complete admin two-factor authentication.');
  return admin;
}
export async function requireFreshAdminMfa(db:D1Database,user:AppUser|null,now=Date.now()){
  const admin=await requireAdminMfa(db,user);
  const proof=await db.prepare('SELECT verified_at FROM admin_mfa_sessions WHERE session_id=? AND user_id=? AND expires_at>?').bind(admin.sessionId,admin.userId,now).first<{verified_at:number}>();
  if(!proof||proof.verified_at>now+30000||now-proof.verified_at>5*60*1000)throw new HttpError(403,'Verify your authenticator again before viewing private verification data.');
  return admin;
}
export async function handleAdminMfa(env:AuthEnvironment,user:AppUser,path:string,raw:unknown){
  requireRole(user,'admin');const db=env.DB,now=Date.now();
  const factor=await db.prepare('SELECT secret,enabled,setup_session,setup_expires,last_counter FROM admin_mfa WHERE user_id=?').bind(user.userId).first<Factor>();
  if(path==='status')return {enrolled:!!factor?.enabled,verified:await adminMfaVerified(db,user)};
  const rate=await db.prepare(`INSERT INTO auth_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`)
    .bind(`admin-mfa:${user.userId}`,now+600000,now,now).first<{count:number}>();
  if(!rate||rate.count>5)throw new HttpError(429,'Too many MFA attempts. Wait ten minutes.');
  if(path==='enroll'){
    z.object({}).strict().parse(raw);
    if(factor?.enabled)throw new HttpError(409,'An authenticator is already enrolled.');
    if(now-user.sessionCreatedAt>600000)throw new HttpError(403,'Sign out and sign in again before enrolling an authenticator.');
    const secret=base32(crypto.getRandomValues(new Uint8Array(20)));
    const encrypted=await symmetricEncrypt({key:env.BETTER_AUTH_SECRET,data:JSON.stringify({userId:user.userId,secret})});
    const changed=await db.prepare(`INSERT INTO admin_mfa(user_id,secret,setup_session,setup_expires) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,setup_session=excluded.setup_session,setup_expires=excluded.setup_expires WHERE admin_mfa.enabled=0`)
      .bind(user.userId,encrypted,user.sessionId,now+600000).run();
    if(!changed.meta.changes)throw new HttpError(409,'An authenticator is already enrolled.');
    return {secret,uri:`otpauth://totp/Foodlane:${encodeURIComponent(user.userId)}?secret=${secret}&issuer=Foodlane&algorithm=SHA1&digits=6&period=30`};
  }
  if(!['confirm','verify','recover'].includes(path))throw new HttpError(404,'Not found.');
  const {code}=z.object({code:z.string().trim().min(6).max(64)}).strict().parse(raw);
  if(!factor|| (path==='confirm' ? factor.enabled||factor.setup_session!==user.sessionId||factor.setup_expires<now : !factor.enabled))throw new HttpError(403,'MFA setup or session is unavailable.');
  const proof=crypto.randomUUID();let counter=-1;let digest='';
  if(path==='recover')digest=await digestToken(`${user.userId}:${code.replaceAll('-','').toLowerCase()}`);
  else {
    if(!/^\d{6}$/.test(code))throw new HttpError(400,'Enter a six-digit authenticator code.');
    const decrypted=JSON.parse(await symmetricDecrypt({key:env.BETTER_AUTH_SECRET,data:factor.secret})) as {userId:string;secret:string};
    if(decrypted.userId!==user.userId)throw new HttpError(403,'MFA unavailable.');
    const current=Math.floor(now/30000);
    for(const candidate of [current,current-1,current+1])if(candidate>factor.last_counter&&constantTimeEqual(await totp(decrypted.secret,candidate),code)){counter=candidate;break;}
    if(counter<0)throw new HttpError(403,'Invalid or already-used code. Wait for the next authenticator code.');
  }
  const recoveryCodes=path==='confirm'?Array.from({length:10},()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')):[];
  const change=path==='recover'
    ? db.prepare('UPDATE admin_mfa SET proof_id=? WHERE user_id=? AND enabled=1 AND EXISTS(SELECT 1 FROM admin_recovery_codes WHERE user_id=? AND digest=?)').bind(proof,user.userId,user.userId,digest)
    : db.prepare(`UPDATE admin_mfa SET enabled=1,last_counter=?,proof_id=? WHERE user_id=? AND secret=? AND last_counter<? AND ${path==='confirm'?'enabled=0 AND setup_session=? AND setup_expires>?':'enabled=1'}`)
      .bind(counter,proof,user.userId,factor.secret,counter,...(path==='confirm'?[user.sessionId,now]:[]));
  const statements=[change,
    db.prepare(`INSERT INTO admin_mfa_sessions(session_id,user_id,verified_at,expires_at,proof_id) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM admin_mfa WHERE user_id=? AND proof_id=?) AND EXISTS(SELECT 1 FROM auth_sessions WHERE id=? AND user_id=? AND expires_at>?) ON CONFLICT(session_id) DO UPDATE SET verified_at=excluded.verified_at,expires_at=excluded.expires_at,proof_id=excluded.proof_id`)
      .bind(user.sessionId,user.userId,now,now+8*3600000,proof,user.userId,proof,user.sessionId,user.userId,now),
  ];
  statements.push(db.prepare('INSERT INTO audit_log(id,subject,action,admin_ref,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM admin_mfa_sessions WHERE session_id=? AND proof_id=?)')
    .bind(crypto.randomUUID(),user.userId,path==='confirm'?'mfa_enrolled':path==='recover'?'mfa_recovery_used':'mfa_verified',user.userId,new Date(now).toISOString(),user.sessionId,proof));
  if(path==='recover')statements.push(db.prepare('DELETE FROM admin_recovery_codes WHERE user_id=? AND digest=? AND EXISTS(SELECT 1 FROM admin_mfa WHERE user_id=? AND proof_id=?)').bind(user.userId,digest,user.userId,proof));
  for(const recovery of recoveryCodes)statements.push(db.prepare('INSERT INTO admin_recovery_codes(digest,user_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM admin_mfa WHERE user_id=? AND proof_id=?)').bind(await digestToken(`${user.userId}:${recovery}`),user.userId,user.userId,proof));
  const result=await db.batch(statements);
  if(!result[0].meta.changes||!result[1].meta.changes)throw new HttpError(403,'Invalid or already-used code.');
  return {verified:true,...(recoveryCodes.length?{recoveryCodes}: {})};
}
