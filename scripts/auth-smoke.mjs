import assert from 'node:assert/strict';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
for (const [path, title] of [
  ['/auth/login', 'Welcome back'], ['/auth/signup', 'Create your account'],
  ['/auth/forgot-password', 'Reset your password'], ['/auth/reset-password', 'Choose a new password'],
  ['/auth/verify', 'Verify your email'], ['/auth/resend', 'Resend verification email'],
]) {
  const response = await fetch(origin + path);
  const body = await response.text();
  assert.equal(response.status, 200, path);
  assert.ok(body.includes(title), path);
  assert.ok(body.includes('no-referrer'), path);
  console.log(`PASS ${path}: rendered screen and no-referrer policy`);
}
const seller = await fetch(origin + '/seller', { redirect: 'manual' });
assert.ok([302, 303, 307].includes(seller.status));
assert.match(seller.headers.get('location'), /\/auth\/login/);
console.log('PASS anonymous seller page redirects to Foodlane login');
assert.equal((await fetch(origin + '/signin-with-chatgpt', { redirect: 'manual' })).status, 404);
console.log('PASS legacy ChatGPT sign-in route removed');
const home = await (await fetch(origin)).text();
assert.ok(!home.includes('signin-with-chatgpt'));
console.log('PASS homepage has no legacy sign-in links');
