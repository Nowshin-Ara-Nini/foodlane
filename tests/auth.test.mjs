import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
// Use the exact workerd/Miniflare/esbuild shipped with the pinned Wrangler.
const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = workerRequire('miniflare');
const { build } = workerRequire('esbuild');
let mf, db;
const origin = 'https://foodlane.test';
let sequence = 0;
async function request(path, body, options = {}) {
  return mf.dispatchFetch(origin + '/api/auth' + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': options.ip ?? `192.0.2.${++sequence}`, ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function messages() { return (await mf.dispatchFetch(origin + '/test/mail')).json(); }
function tokenFrom(mail) { return new URL(mail.text.split('\n')[1]).searchParams.get('token'); }
function cookieFrom(response) { return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; '); }
before(async () => {
  await mkdir('.wrangler/auth-tests', { recursive: true });
  await build({ entryPoints: ['tests/auth-worker.ts'], bundle: true, outfile: '.wrangler/auth-tests/worker.mjs', format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'], external: ['node:*'], define: { 'process.env.NODE_ENV': '"test"' } });
  mf = new Miniflare({ modules: true, scriptPath: '.wrangler/auth-tests/worker.mjs', compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: {
    AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'test-only-secret-with-more-than-thirty-two-characters', RESEND_API_KEY: 'fake', AUTH_EMAIL_FROM: 'test@foodlane.test',
    GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret',
  } });
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile('drizzle/' + file, 'utf8');
    const statements = sql.split(';').map(s => s.replaceAll('--> statement-breakpoint', '').trim()).filter(Boolean);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
});
after(async () => { await mf?.dispose(); });

test('email verification, secure sessions, password reset, replay protection and logout', async () => {
  const user = { email: 'buyer@example.com', name: 'Buyer', password: 'An excellent password 42' };
  const signup = await request('/sign-up/email', user);
  assert.equal(signup.status, 200, await signup.clone().text());
  assert.equal(signup.headers.get('set-cookie'), null);
  const record = await db.prepare('SELECT email_verified FROM auth_users WHERE email = ?').bind(user.email).first();
  assert.equal(record.email_verified, 0);
  const account = await db.prepare('SELECT password FROM auth_accounts').first();
  assert.notEqual(account.password, user.password);
  const verificationToken = tokenFrom((await messages())[0]);
  assert.equal((await request('/sign-in/email', user)).status, 401);
  assert.equal((await request('/verify-email', { token: verificationToken })).status, 200);
  assert.equal((await request('/verify-email', { token: verificationToken })).status, 400);
  const login = await request('/sign-in/email', user);
  assert.equal(login.status, 200, await login.clone().text());
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i); assert.match(setCookie, /SameSite=Lax/i);
  const cookie = cookieFrom(login);
  const session = await request('/get-session', undefined, { headers: { Cookie: cookie } });
  assert.equal((await session.json()).user.email, user.email);
  await request('/request-password-reset', { email: user.email });
  const resetToken = tokenFrom((await messages())[0]);
  const reset = await request('/reset-password', { token: resetToken, newPassword: 'Another excellent password 43' });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal((await request('/reset-password', { token: resetToken, newPassword: 'A third excellent password 44' })).status, 400);
  assert.equal(await (await request('/get-session', undefined, { headers: { Cookie: cookie } })).json(), null);
  assert.equal((await request('/sign-in/email', user)).status, 401);
  const nextLogin = await request('/sign-in/email', { email: user.email, password: 'Another excellent password 43' });
  assert.equal(nextLogin.status, 200);
  const nextCookie = cookieFrom(nextLogin);
  assert.equal((await request('/sign-out', {}, { headers: { Cookie: nextCookie } })).status, 200);
  assert.equal(await (await request('/get-session', undefined, { headers: { Cookie: nextCookie } })).json(), null);
});

test('generic account responses, CSRF, forged identity and disabled legacy endpoints', async () => {
  const known = await request('/sign-up/email', { email: 'buyer@example.com', name: 'Buyer', password: 'An excellent password 42' });
  const unknown = await request('/sign-up/email', { email: 'new@example.com', name: 'New', password: 'An excellent password 42' });
  assert.equal(await known.text(), await unknown.text());
  await messages();
  const forgotKnown = await request('/request-password-reset', { email: 'buyer@example.com' });
  const forgotUnknown = await request('/request-password-reset', { email: 'missing@example.com' });
  assert.equal(await forgotKnown.text(), await forgotUnknown.text());
  await messages();
  assert.equal((await request('/sign-in/email', {}, { headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await request('/sign-in/email', {}, { headers: { Origin: '' } })).status, 403);
  assert.equal(await (await request('/get-session', undefined, { headers: { 'oai-authenticated-user-id': 'admin', 'oai-authenticated-user-email': 'admin@example.com' } })).json(), null);
  assert.equal((await request('/delete-user', {})).status, 404);
  assert.equal((await request('/verify-email')).status, 404);
});

test('expired verification/reset tokens are rejected', async () => {
  await request('/sign-up/email', { email: 'expired@example.com', name: 'Expired', password: 'An excellent password 42' });
  const token = tokenFrom((await messages())[0]);
  await db.prepare('UPDATE auth_email_links SET expires_at = 0').run();
  assert.equal((await request('/verify-email', { token })).status, 400);
  await request('/request-password-reset', { email: 'buyer@example.com' });
  const reset = tokenFrom((await messages())[0]);
  await db.prepare('UPDATE auth_verifications SET expires_at = 0 WHERE identifier LIKE ?').bind('reset-password:%').run();
  assert.equal((await request('/reset-password', { token: reset, newPassword: 'An excellent password 44' })).status, 400);
});

test('atomic rate limits persist across handler instances and concurrent attempts', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/sign-in/email', { email: `limit${i}@example.com`, password: 'incorrect password' }, { ip: '198.51.100.25' })));
  assert.equal(responses.filter(r => r.status === 429).length, 3);
  assert.ok(Number(responses.find(r => r.status === 429).headers.get('Retry-After')) > 0);
  const keys = await db.prepare('SELECT key FROM auth_limits').all();
  assert.ok(keys.results.every(row => /^[a-f0-9]{64}$/.test(row.key)));
});

test('Google starts state-protected OAuth and rejects unsolicited callbacks', async () => {
  const response = await request('/sign-in/social', { provider: 'google', callbackURL: origin + '/' });
  assert.equal(response.status, 200, await response.clone().text());
  const target = new URL((await response.json()).url);
  assert.equal(target.hostname, 'accounts.google.com');
  assert.ok(target.searchParams.get('state'));
  assert.equal(target.searchParams.get('redirect_uri'), origin + '/api/auth/callback/google');
  const callback = await request('/callback/google?code=forged&state=forged');
  assert.ok(callback.status >= 300);
  assert.doesNotMatch(callback.headers.get('set-cookie') ?? '', /session_token=/);
});

test('verification redemption is atomic and sessions expire server-side', async () => {
  const user = { email: 'concurrent@example.com', name: 'Concurrent', password: 'Another excellent password 46' };
  await request('/sign-up/email', user);
  const token = tokenFrom((await messages())[0]);
  const results = await Promise.all([request('/verify-email', { token }), request('/verify-email', { token })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  const login = await request('/sign-in/email', user);
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  await db.prepare('UPDATE auth_sessions SET expires_at = 0').run();
  assert.equal(await (await request('/get-session', undefined, { headers: { Cookie: cookie } })).json(), null);
});

test('insecure origin, external OAuth redirect and oversized body are rejected', async () => {
  const insecure = await mf.dispatchFetch('http://foodlane.test/api/auth/get-session');
  assert.equal(insecure.status, 403);
  const redirect = await request('/sign-in/social', { provider: 'google', callbackURL: 'https://attacker.test/' });
  assert.equal(redirect.status, 403);
  const oversized = await request('/sign-in/email', { email: 'oversized@example.com', password: 'x'.repeat(20000) });
  assert.equal(oversized.status, 400);
});

test('scrypt runs in workerd; record local round-trip latency, not deployed CPU', async (t) => {
  const measurements = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    assert.equal((await (await mf.dispatchFetch(origin + '/test/hash')).json()).valid, true);
    measurements.push(Math.round(performance.now() - start));
  }
  t.diagnostic(`Local workerd hash+verify round-trip ms: ${measurements.join(', ')}. This is NOT production CPU usage.`);
});
