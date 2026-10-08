import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';

const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json'));
test('built admin pages and APIs enforce MFA through enrollment, logout and recovery',async()=>{
  const config=JSON.parse(await readFile('dist/server/wrangler.json','utf8'));
  const paths=(await readdir('dist/server',{recursive:true})).filter(p=>p.endsWith('.js')&&p!==config.main);
  const {Miniflare}=wr('miniflare'),origin='https://foodlane.test';
  const mf=new Miniflare({modules:[config.main,...paths].map(path=>({type:'ESModule',path:resolve('dist/server',path)})),modulesRoot:resolve('dist/server'),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,d1Databases:['DB'],r2Buckets:['BUCKET','PRIVATE_VERIFICATIONS'],outboundService:async(req)=>{const url=new URL(req.url);if(url.hostname!=='supabase.test')return fetch(req);if(url.pathname==='/auth/v1/token'){return Response.json({access_token:'built-admin-access',refresh_token:'built-admin-refresh',expires_in:3600,user:{id:'built-admin',email:'admin@example.test',email_confirmed_at:new Date().toISOString(),user_metadata:{name:'Test Admin'}}});}if(url.pathname==='/auth/v1/user')return Response.json({id:'built-admin',email:'admin@example.test',email_confirmed_at:new Date().toISOString(),user_metadata:{name:'Test Admin'}});if(url.pathname==='/auth/v1/logout')return new Response(null,{status:204});return new Response(null,{status:404});},bindings:{SUPABASE_URL:'https://supabase.test',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',AUTH_BASE_URL:origin,BETTER_AUTH_SECRET:'built-test-only-secret-over-thirty-two-characters',AUTH_EMAIL_FROM:'test@example.test',RESEND_API_KEY:'test-only'}});
  try{
    const db=await mf.getD1Database('DB');
    for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())await db.batch((await readFile('drizzle/'+file,'utf8')).split(';').map(s=>s.replaceAll('--> statement-breakpoint','').trim()).filter(Boolean).map(s=>db.prepare(s)));
    await db.prepare("INSERT INTO auth_users(id,name,email,email_verified,role,role_chosen,created_at,updated_at) VALUES('built-admin','Test Admin','admin@example.test',1,'admin',1,?,?)").bind(Date.now(),Date.now()).run();
    let cookie='';
    const request=(path,data)=>mf.dispatchFetch(origin+path,{redirect:'manual',method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    const signIn=async()=>{const start=await request('/api/auth/sign-in/social',{provider:'google'});assert.equal(start.status,200,await start.clone().text());const flow=start.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const state=decodeURIComponent(flow.split('; ').find(c=>c.startsWith('foodlane_oauth_state=')).split('=').slice(1).join('='));const r=await mf.dispatchFetch(origin+'/api/auth/callback?code=built-code&flow_state='+encodeURIComponent(state),{redirect:'manual',headers:{Cookie:flow}});assert.equal(r.status,303);cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.ok(cookie.includes('foodlane_session='));};
    assert.equal((await mf.dispatchFetch('http://foodlane.test/')).status,403);
    const policy=await request('/privacy');assert.equal(policy.status,200);const privacyHtml=await policy.text();assert.match(privacyHtml,/nowshinaranini@gmail.com/);assert.match(privacyHtml,/30 days after approval/);assert.match(privacyHtml,/Supabase/);assert.match(privacyHtml,/Google/);assert.match(privacyHtml,/NID photos never become public/);
    assert.equal((await request('/account')).status,307);
    const headers=await request('/');assert.equal(headers.headers.get('x-frame-options'),'DENY');assert.equal(headers.headers.get('x-content-type-options'),'nosniff');assert.match(headers.headers.get('strict-transport-security'),/max-age/);assert.match(headers.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const home=await request('/');assert.equal(home.status,200);assert.doesNotMatch(await home.text(),/maps.google.com|<iframe/);
    const map=await request('/map');assert.equal(map.status,200);const mapHtml=await map.text();assert.match(mapHtml,/Find food here/);assert.match(mapHtml,/Near me/);assert.match(mapHtml,/Google Maps|Choose a location/);assert.match(mapHtml,/Location|location/);
    const sellerPage=await request('/sellers/test-seller');assert.equal(sellerPage.status,200);assert.match(await sellerPage.text(),/Explore nearby sellers/);
    const emptyDiscovery=await request('/api/public/sellers?lat=0&lng=180');assert.equal(emptyDiscovery.status,200);assert.deepEqual((await emptyDiscovery.json()).sellers,[]);
    const anonymous=await request('/admin');assert.equal(anonymous.status,307);assert.match(anonymous.headers.get('location'),/\/auth\/login/);
    await signIn();
    const locked=await request('/admin');assert.equal(locked.status,307);assert.equal(locked.headers.get('location'),'/admin/mfa');assert.equal(locked.headers.get('cache-control'),'private, no-store');
    assert.equal((await request('/api/admin/verifications/guessed/documents/identity')).status,403);
    assert.match(await (await request('/admin/mfa')).text(),/Set up authenticator/);
    const setup=await (await request('/api/admin/mfa/enroll',{})).json();
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes=[];
    for(const c of setup.secret){value=(value<<5)|alphabet.indexOf(c);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const h=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=h[19]&15,code=String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
    const confirmed=await request('/api/admin/mfa/confirm',{code});assert.equal(confirmed.status,200,await confirmed.clone().text());const {recoveryCodes}=await confirmed.json();
    const panel=await request('/admin');assert.equal(panel.status,200);assert.match(await panel.text(),/Verification review desk/);assert.equal(panel.headers.get('cache-control'),'private, no-store');assert.equal(panel.headers.get('referrer-policy'),'no-referrer');
    assert.equal((await request('/api/admin/audit')).status,200);
    assert.equal((await request('/api/admin/reports')).status,200);assert.equal((await request('/api/admin/accounts')).status,200);assert.equal((await request('/api/admin/cleanup')).status,200);
    const accountPage=await request('/account');assert.equal(accountPage.status,200);assert.equal(accountPage.headers.get('cache-control'),'private, no-store');assert.match(await accountPage.text(),/Permanently delete my account/);

    assert.equal((await request('/review')).headers.get('location'),'/admin');
    assert.equal((await request('/api/auth/sign-out',{})).status,200);
    assert.equal((await request('/api/admin/audit')).status,403);
    await signIn();assert.equal((await request('/admin')).headers.get('location'),'/admin/mfa');
    assert.match(await (await request('/admin/mfa')).text(),/Authenticator code/);
    assert.equal((await request('/api/admin/mfa/recover',{code:recoveryCodes[0]})).status,200);
    assert.equal((await request('/admin')).status,200);
    await db.prepare("INSERT INTO auth_limits(key,count,expires_at) VALUES('expired-test',1,0)").run();
    await db.prepare("INSERT INTO auth_email_links(digest,expires_at) VALUES('expired-test',0)").run();
    await db.prepare("INSERT INTO auth_verifications(id,identifier,value,expires_at,created_at,updated_at) VALUES('expired-test','test','test',0,0,0)").run();
    const scheduled=await (await mf.getWorker()).scheduled({cron:'*/15 * * * *'});assert.equal(scheduled.outcome,'ok');
    for(const [table,column] of [['auth_limits','key'],['auth_email_links','digest'],['auth_verifications','id']])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}='expired-test'`).first()).n,0);
  }finally{await mf.dispose()}
});
