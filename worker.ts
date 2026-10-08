import handler from 'vinext/server/fetch-handler';
import { cleanupVerificationFiles, cleanupAccountDeletions } from './lib/verification-retention';
import type { PrivateEnvironment } from './lib/private-verification';
import type { AuthEnvironment } from './lib/auth';
import { rateLimit, RateLimitError } from './lib/api-security';

const worker = {
  async fetch(request:Request,env:PrivateEnvironment&AuthEnvironment,ctx:ExecutionContext) {
    const url=new URL(request.url);
    if(url.protocol!=='https:'&&!(env.AUTH_ALLOW_LOCAL_HTTP==='true'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))return new Response('HTTPS is required.',{status:403});
    if(['/api/action','/api/data','/api/photo','/api/evidence'].includes(url.pathname)){
      try{await rateLimit(env,'ip',request.headers.get('cf-connecting-ip')??'local-or-unknown',300,60);}
      catch(error){return Response.json({error:error instanceof RateLimitError?error.message:'Request unavailable.'},{status:error instanceof RateLimitError?429:503,headers:{'Cache-Control':'private, no-store',...(error instanceof RateLimitError?{'Retry-After':String(error.retryAfter)}:{})}});}
    }
    const response=await handler.fetch(request,env,ctx);
    const path=url.pathname,headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('X-Frame-Options','DENY');
    if(!headers.has('Content-Security-Policy'))headers.set('Content-Security-Policy',"frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
    headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=(self)');
    if(url.protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
    if(/^\/(admin|account|seller|auth)(\/|$)/.test(path)||path.startsWith('/api/')||path==='/review') {
      headers.set('Cache-Control','private, no-store');
      headers.set('Referrer-Policy','no-referrer');
    }
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  },
  async scheduled(_event: ScheduledController, env: PrivateEnvironment & AuthEnvironment, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const now=Date.now();
      await env.DB.prepare("INSERT INTO cleanup_health(id,started_at) VALUES('cleanup',?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at").bind(now).run();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM auth_verifications WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM auth_email_links WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM auth_limits WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM deletion_challenges WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM admin_mfa_sessions WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM admin_mfa WHERE enabled=0 AND setup_expires<=?').bind(now),
      ]);
      const accounts=await cleanupAccountDeletions(env);
      let failed=accounts.pending;
      // Bounded batches. Any backlog remains durable for the next scheduled run.
      for (let i = 0; i < 20; i++) {
        const result = await cleanupVerificationFiles(env);
        failed+=result.failed;
        if (result.scanned < 100) break;
      }
      const counts=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM account_deletion_jobs) accounts,(SELECT COUNT(*) FROM verification_files WHERE object_key IS NOT NULL AND delete_after IS NOT NULL) files").first<{accounts:number;files:number}>();
      await env.DB.prepare("UPDATE cleanup_health SET completed_at=?,accounts_pending=?,files_pending=? WHERE id='cleanup'").bind(Date.now(),counts?.accounts??0,counts?.files??0).run();
      console.log('CLEANUP_COUNTS',JSON.stringify({accountsPending:counts?.accounts??0,filesPending:counts?.files??0,failed}));
      if(failed)throw new Error('Cleanup requires retry.');
    })().catch(async()=>{
      console.error('SCHEDULED_CLEANUP_FAILED');
      await env.DB.prepare("UPDATE cleanup_health SET failed_at=? WHERE id='cleanup'").bind(Date.now()).run();
      throw new Error('Scheduled cleanup failed.');
    }));
  },
};
export default worker;
