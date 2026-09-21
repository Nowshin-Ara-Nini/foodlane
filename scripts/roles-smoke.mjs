import assert from 'node:assert/strict';
const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
for (const path of ['/api/admin/verifications','/api/admin/verifications/guessed/documents/identity','/api/seller/dashboard','/api/buyer/interests','/api/evidence?key=guessed']) {
  const response = await fetch(origin + path);
  assert.equal(response.status,403,path);
  console.log(`PASS anonymous ${path}: 403`);
}
for (const path of ['/api/action','/api/data','/api/photo']) {
  assert.equal((await fetch(origin + path)).status,410,path);
  console.log(`PASS retired ${path}: 410`);
}
assert.equal((await fetch(origin + '/api/public/catalogue')).status,200);
console.log('PASS public catalogue remains available anonymously');
for (const path of ['/seller','/review','/admin','/auth/choose-role']) {
  const response = await fetch(origin + path,{redirect:'manual'});
  assert.equal(response.status,307,path);
  assert.match(response.headers.get('location'),/\/auth\/login/);
  console.log(`PASS anonymous ${path}: login redirect`);
}
