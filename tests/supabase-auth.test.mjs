import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = workerRequire('miniflare');
const ts = workerRequire('typescript');
let mf, db;
const origin='https://foodlane.test';
async function request(path,body,options={}) {
  return mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{'Content-Type':'application/json',Origin:origin,'CF-Connecting-IP':options.ip??'192.0.2.9',...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function cookieHeader(response){return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}
function cookieValue(header,name){const value=header.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='));return value?.slice(name.length+1)}
before(async()=>{
  const root='.wrangler/supabase-auth-tests';
  await mkdir(root+'/lib',{recursive:true}); await mkdir(root+'/tests',{recursive:true});
  const compile=async(source,target,replacements=[])=>{let code=ts.transpileModule(await readFile(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;for(const [from,to] of replacements)code=code.replaceAll(from,to);await writeFile(target,code)};
  await compile('lib/auth-policy.ts',root+'/lib/auth-policy.mjs');
  await compile('lib/supabase-auth.ts',root+'/lib/supabase-auth.mjs',[ ["'./auth-policy'","'./auth-policy.mjs'"] ]);
  await compile('tests/supabase-auth-worker.ts',root+'/tests/worker.mjs',[ ["'../lib/supabase-auth'","'../lib/supabase-auth.mjs'"] ]);
  mf=new Miniflare({modules:true,scriptPath:root+'/tests/worker.mjs',compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{AUTH_BASE_URL:origin,BETTER_AUTH_SECRET:'test-only-secret-with-more-than-thirty-two-characters',RESEND_API_KEY:'fake',AUTH_EMAIL_FROM:'test@foodlane.test',SUPABASE_URL:'https://supabase.test',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test'}});
  db=await mf.getD1Database('DB');
  for(const file of (await readdir('drizzle')).filter(name=>name.endsWith('.sql')).sort()){
    const sql=await readFile('drizzle/'+file,'utf8');
    const statements=sql.split(';').map(value=>value.replaceAll('--> statement-breakpoint','').trim()).filter(Boolean);
    await db.batch(statements.map(statement=>db.prepare(statement)));
  }
});
after(async()=>{await mf?.dispose()});

test('Google OAuth creates a verified opaque session and leaves role selection for onboarding',async()=>{
  const start=await request('/api/auth/sign-in/social',{provider:'google',returnTo:'/map'});
  assert.equal(start.status,200);
  const {url}=await start.json();
  const authorize=new URL(url);
  assert.equal(authorize.hostname,'supabase.test');
  assert.equal(authorize.pathname,'/auth/v1/authorize');
  assert.equal(authorize.searchParams.get('provider'),'google');
  assert.match(authorize.searchParams.get('redirect_to')??'',/returnTo=%2Fmap/);
  const flowCookies=cookieHeader(start);
  const state=decodeURIComponent(cookieValue(flowCookies,'foodlane_oauth_state')??'');
  assert.ok(state);
  const callback=await mf.dispatchFetch(`${origin}/api/auth/callback?code=google-code&returnTo=%2Fmap&flow_state=${encodeURIComponent(state)}`,{headers:{Cookie:flowCookies},redirect:'manual'});
  assert.equal(callback.status,303);
  assert.equal(new URL(callback.headers.get('location')).pathname,'/auth/choose-role');
  assert.equal(new URL(callback.headers.get('location')).searchParams.get('returnTo'),'/map');
  const sessionCookies=cookieHeader(callback);
  const sessionCookie=cookieValue(sessionCookies,'foodlane_session');
  assert.ok(sessionCookie);
  assert.match(callback.headers.get('set-cookie')??'',/HttpOnly/i);
  const user=await db.prepare('SELECT name,email,image,role,role_chosen FROM auth_users WHERE id=?').bind('google-user-1').first();
  assert.deepEqual(user,{name:'Google Buyer',email:'buyer@example.test',image:'https://lh3.googleusercontent.com/avatar',role:'buyer',role_chosen:0});
  const session=await request('/api/auth/get-session',undefined,{headers:{Cookie:`foodlane_session=${sessionCookie}`}});
  const data=await session.json();
  assert.equal(data.user.emailVerified,true);
  assert.equal(data.user.name,'Google Buyer');
  assert.equal(data.user.image,'https://lh3.googleusercontent.com/avatar');
  assert.doesNotMatch(JSON.stringify(data),/access_token|refresh_token/);
  await db.prepare('UPDATE auth_users SET role_chosen=1,image=NULL,name=? WHERE id=?').bind('My Foodlane Name','google-user-1').run();
  const returning=await request('/api/auth/get-session',undefined,{headers:{Cookie:`foodlane_session=${sessionCookie}`}});
  const returningData=await returning.json();
  assert.equal(returningData.user.name,'My Foodlane Name');
  assert.equal(returningData.user.image,null);
  const logout=await request('/api/auth/sign-out',{}, {headers:{Cookie:`foodlane_session=${sessionCookie}`}});
  assert.equal(logout.status,200);
  assert.equal(await (await request('/api/auth/get-session',undefined,{headers:{Cookie:`foodlane_session=${sessionCookie}`} })).json(),null);
});

test('email and password authentication endpoints are disabled',async()=>{
  for(const path of ['/sign-up/email','/sign-in/email','/request-password-reset','/reset-password','/send-verification-email']){
    const response=await request('/api/auth'+path,{email:'buyer@example.test',password:'Correct Horse Battery 42',name:'Buyer'});
    assert.equal(response.status,404,path);
  }
});

test('Google initiation rejects untrusted origins and applies persistent rate limits',async()=>{
  const csrf=await request('/api/auth/sign-in/social',{provider:'google'},{headers:{Origin:'https://attacker.test'},ip:'192.0.2.10'});
  assert.equal(csrf.status,403);
  let last;
  for(let index=0;index<22;index++) last=await request('/api/auth/sign-in/social',{provider:'google'},{ip:'192.0.2.11'});
  assert.equal(last.status,429);
});

test('Google callback rejects a missing or mismatched OAuth state',async()=>{
  const callback=await mf.dispatchFetch(`${origin}/api/auth/callback?code=google-code&flow_state=wrong`,{redirect:'manual'});
  assert.equal(callback.status,303);
  assert.ok((callback.headers.get('location')??'').includes('/auth/login?error=callback'));
});

async function googleLogin() {
  const start=await request('/api/auth/sign-in/social',{provider:'google'},{ip:'192.0.2.40'});const cookies=cookieHeader(start),state=decodeURIComponent(cookieValue(cookies,'foodlane_oauth_state'));
  return mf.dispatchFetch(`${origin}/api/auth/callback?code=google-code&flow_state=${encodeURIComponent(state)}`,{headers:{Cookie:cookies},redirect:'manual'});
}
test('temporary provider failures preserve sessions, refresh recovers, and revoked credentials end access',async()=>{
  const login=await googleLogin();assert.equal(login.status,303);const cookie=cookieHeader(login);
  await db.prepare('UPDATE auth_sessions SET provider_expires_at=0 WHERE user_id=?').bind('google-user-1').run();
  for(const status of [503,429]){await request('/test/provider',{refresh:status});assert.equal((await request('/api/auth/get-session',undefined,{headers:{Cookie:cookie}})).status,503);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE user_id=?').bind('google-user-1').first()).n,1);}
  await request('/test/provider',{refresh:200});assert.equal((await request('/api/auth/get-session',undefined,{headers:{Cookie:cookie}})).status,200);
  await request('/test/provider',{provider:503});assert.equal((await request('/api/auth/get-session',undefined,{headers:{Cookie:cookie}})).status,503);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE user_id=?').bind('google-user-1').first()).n,1);
  await request('/test/provider',{refresh:400});await db.prepare('UPDATE auth_sessions SET provider_expires_at=0').run();assert.equal(await (await request('/api/auth/get-session',undefined,{headers:{Cookie:cookie}})).json(),null);
});
test('banned and deleting accounts cannot obtain a new Google session',async()=>{
  await request('/test/provider',{});
  for(const status of ['banned','deleting']){await db.prepare('UPDATE auth_users SET account_status=? WHERE id=?').bind(status,'google-user-1').run();const callback=await googleLogin();assert.equal(callback.status,303);assert.match(callback.headers.get('location'),/account-unavailable/);assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE user_id=?').bind('google-user-1').first()).n,0);}
  await db.prepare("UPDATE auth_users SET account_status='active' WHERE id=?").bind('google-user-1').run();assert.equal((await googleLogin()).status,303);
});
