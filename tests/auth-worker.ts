// Test-only Worker: never referenced by the application deployment configuration.
import { createAuth, type AuthMail } from '../lib/auth';
import { handleFoodlane, type FoodlaneEnvironment } from '../lib/foodlane-api';
import { handleAuth } from '../lib/auth-handler';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { encryptNid } from '../lib/nid-crypto';
import { cleanupVerificationFiles, deleteAccountData } from '../lib/verification-retention';
import { sanitizeImage } from '../lib/image-sanitization';
const mail: AuthMail[] = [];
const worker = {
  async fetch(request: Request, env: FoodlaneEnvironment) {
    const path = new URL(request.url).pathname;
    if (path === '/test/seed-verification') {
      const {id,seller,age,photo} = await request.json() as {id:string;seller:string;age:number;photo:number[]};
      const encrypted = await encryptNid(env,'1234567890123',id), now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO seller_verifications(id,seller_id,legal_name,age,gender,personal_email,personal_phone,home_address,nid_ciphertext,nid_iv,nid_key_version,place_address,place_lat,place_lng,note,created,location_notice_version,location_accepted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,seller,'Private legal name',age,'Other','private@example.com','private-phone','private-home',encrypted.ciphertext,encrypted.iv,encrypted.version,'Public pickup',23,90,'Details',now,'test-v1',now).run();
      for (const kind of ['nid','passport','place']) {
        const file = crypto.randomUUID(), key = `${kind}/${seller}/${file}.png`;
        await env.PRIVATE_VERIFICATIONS!.put(key,new Uint8Array(photo),{httpMetadata:{contentType:'image/png'}});
        await env.DB.prepare("INSERT INTO verification_files(id,subject,submission_id,kind,bucket,object_key,state,created_at) VALUES(?,?,?,?,'private',?,'attached',?)").bind(file,seller,id,kind,key,now).run();
      }
      return Response.json({ok:true});
    }
    if (path === '/test/cleanup') {
      const data = await request.json() as {now?:string;fail?:boolean};
      return Response.json(await cleanupVerificationFiles(data.fail?{...env,PRIVATE_VERIFICATIONS:undefined}:env,data.now));
    }
    if (path === '/test/delete-account') {
      const data = await request.json() as {userId:string;fail?:boolean};
      return Response.json(await deleteAccountData(data.fail?{...env,PRIVATE_VERIFICATIONS:undefined}:env,data.userId));
    }
    if (path === '/test/sanitize') {
      const fields = await request.formData();
      try { return new Response(new Uint8Array(await sanitizeImage(fields.get('photo') as File, env.IMAGES))); }
      catch { return new Response('Rejected',{status:400}); }
    }
    if (path === '/test/mail') return Response.json(mail.splice(0));
    if (path === '/test/hash') {
      const hash = await hashPassword('Benchmark-only password 2026');
      return Response.json({ valid: await verifyPassword({ hash, password: 'Benchmark-only password 2026' }) });
    }
    if (path.startsWith('/api/auth/')) return handleAuth(request, env, createAuth(env, async (message) => { mail.push(message); }));
    return handleFoodlane(request, env);
  },
};
export default worker;
