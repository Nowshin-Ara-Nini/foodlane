import { z } from 'zod';
import { type AuthEnvironment, type AuthMail, deliverAuthMail } from './auth';
import { fingerprint, rateLimit } from './api-security';
import { type AppUser, HttpError } from './permissions';
import { type PrivateEnvironment } from './private-verification';
import { deleteAccountData } from './verification-retention';

export async function sendDeletionCode(env:AuthEnvironment,user:AppUser,sendMail?:(mail:AuthMail)=>Promise<void>) {
  await rateLimit(env,'delete-email',user.userId,3,900);
  const row=await env.DB.prepare('SELECT email FROM auth_users WHERE id=? AND email_verified=1').bind(user.userId).first<{email:string}>();
  if(!row)throw new HttpError(403,'Verified account required.');
  // High-entropy code, never in a URL, tied to this exact session and user.
  const code=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  const digest=await fingerprint(env,`delete:${user.sessionId}:${user.userId}:${code}`);
  await env.DB.prepare('INSERT INTO deletion_challenges(session_id,user_id,digest,expires_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET digest=excluded.digest,expires_at=excluded.expires_at').bind(user.sessionId,user.userId,digest,Date.now()+600000).run();
  try {await (sendMail??((mail)=>deliverAuthMail(env,mail)))({to:row.email,subject:'Confirm Foodlane account deletion',text:`To permanently delete your Foodlane account, enter this code on the Account page within 10 minutes:\n${code}\n\nThis works only in the browser session that requested it. Ignore this email if you did not request deletion.`});}
  catch {await env.DB.prepare('DELETE FROM deletion_challenges WHERE session_id=? AND digest=?').bind(user.sessionId,digest).run();throw new HttpError(503,'Could not send the confirmation email. Please try again later.');}
  return {ok:true,message:'A confirmation code has been sent to your verified account email. It expires in 10 minutes.'};
}
export async function confirmDeletion(env:AuthEnvironment&PrivateEnvironment,user:AppUser,raw:unknown) {
  await rateLimit(env,'delete-confirm',user.userId,5,900);
  const data=z.object({code:z.string().trim().regex(/^[a-f0-9]{32}$/),confirmation:z.literal('DELETE')}).strict().parse(raw);
  const digest=await fingerprint(env,`delete:${user.sessionId}:${user.userId}:${data.code}`);
  const challenge=await env.DB.prepare('DELETE FROM deletion_challenges WHERE session_id=? AND user_id=? AND digest=? AND expires_at>? RETURNING session_id').bind(user.sessionId,user.userId,digest,Date.now()).first();
  if(!challenge)throw new HttpError(403,'Invalid, expired or already used confirmation code.');
  return deleteAccountData(env,user.userId);
}
