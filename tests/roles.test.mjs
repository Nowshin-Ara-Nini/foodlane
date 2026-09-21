import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { adminProvisionStatements } from '../scripts/admin-provision-sql.mjs';
const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = workerRequire('miniflare');
const { build } = workerRequire('esbuild');
let mf, db, bucket, privateBucket, buyer, sellerA, sellerB, admin, pendingSeller;
const origin = 'https://foodlane.test'; let sequence = 0;
async function request(path, cookie, data, extra = {}) {
  if (data instanceof FormData) {
    const encoded = new Request(origin + path, { method: 'POST', body: data });
    return mf.dispatchFetch(encoded.url, { method: 'POST', headers: { Origin: origin, Cookie: cookie ?? '', ...Object.fromEntries(encoded.headers), ...extra }, body: new Uint8Array(await encoded.arrayBuffer()) });
  }
  return mf.dispatchFetch(origin + path, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
    Origin: origin, Cookie: cookie ?? '', 'CF-Connecting-IP': `192.0.2.${++sequence}`,
    ...(data instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...extra,
  }, ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) }) });
}
async function account(name, signupRole = 'buyer') {
  const credentials = { name, email: `${name}@example.com`, password: 'A test-only strong password 42', signupRole };
  const signup = await request('/api/auth/sign-up/email', '', credentials);
  assert.equal(signup.status, 200, await signup.clone().text());
  const mail = await (await mf.dispatchFetch(origin + '/test/mail')).json();
  const token = new URL(mail[0].text.split('\n')[1]).searchParams.get('token');
  assert.equal((await request('/api/auth/verify-email', '', { token })).status, 200);
  const login = await request('/api/auth/sign-in/email', '', { email: credentials.email, password: credentials.password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const user = await db.prepare('SELECT id,role,role_chosen FROM auth_users WHERE email=?').bind(credentials.email).first();
  assert.equal(user.role, signupRole); assert.equal(user.role_chosen, 1);
  return { id: user.id, cookie };
}
async function seedSeller(account, id, status) {
  await db.prepare('INSERT INTO sellers VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,account.id,id,'private-phone', 'Food','Public pickup point',23.74,90.37,'Noon',status,new Date().toISOString()).run();
  const photo = `food/${id}/11111111-1111-4111-8111-111111111111.png`;
  await bucket.put(photo, 'test-public-image', { httpMetadata: { contentType: 'image/jpeg' } });
  await db.prepare("INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at) VALUES(?,?,'food','media',?,'attached',?)").bind('file-'+id,id,photo,new Date().toISOString()).run();
  await db.prepare('INSERT INTO foods VALUES(?,?,?,?,?,?,?,?)').bind(`food-${id}`,id,'Rice','Fresh',100,'Home cooking',photo,1).run();
}
const sharp = createRequire(workerRequire.resolve('miniflare'))('sharp');
const fixture = await sharp({create:{width:4,height:3,channels:3,background:'#228833'}}).png().toBuffer();
async function submission(id, seller, age = 25) {
  const response = await mf.dispatchFetch(origin+'/test/seed-verification',{method:'POST',body:JSON.stringify({id,seller,age,photo:[...fixture]})});
  assert.equal(response.status,200,await response.clone().text());
}
before(async () => {
  await mkdir('.wrangler/role-tests', { recursive: true });
  await build({ entryPoints: ['tests/auth-worker.ts'], bundle: true, outfile: '.wrangler/role-tests/worker.mjs', format: 'esm', platform: 'neutral', conditions: ['workerd','worker','browser'], mainFields: ['module','main'], external: ['node:*'], define: { 'process.env.NODE_ENV': '"test"' } });
  mf = new Miniflare({ modules: true, scriptPath: '.wrangler/role-tests/worker.mjs', compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET','PRIVATE_VERIFICATIONS'], images: {binding:'IMAGES'}, bindings: { NID_ENCRYPTION_KEYS: JSON.stringify({v1:Buffer.alloc(32,7).toString('base64')}), AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'test-only-secret-with-more-than-thirty-two-characters', RESEND_API_KEY: 'fake', AUTH_EMAIL_FROM: 'test@foodlane.test' } });
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('BUCKET'); privateBucket = await mf.getR2Bucket('PRIVATE_VERIFICATIONS');
  for (const file of (await readdir('drizzle')).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith('0005_')) {
      await db.prepare("INSERT INTO auth_users(id,name,email,email_verified,created_at,updated_at) VALUES('legacy-user','Legacy','legacy@example.com',1,0,0)").run();
      await db.prepare("INSERT INTO sellers VALUES('legacy-seller','legacy-user','Legacy','','Food','Pickup',23,90,'Noon','unverified','2026-01-01')").run();
      await db.prepare("INSERT INTO foods VALUES('legacy-food','legacy-seller','Rice','Fresh',100,'Other','old-key',1)").run();
    }
    const sql = await readFile('drizzle/' + file, 'utf8');
    await db.batch(sql.split(';').map(s => s.replaceAll('--> statement-breakpoint', '').trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  buyer = await account('rolebuyer'); sellerA = await account('sellera','seller'); sellerB = await account('sellerb','seller');
  pendingSeller = await account('pending','seller'); admin = await account('admin');
  await db.prepare("UPDATE auth_users SET role='admin' WHERE id=?").bind(admin.id).run();
  await seedSeller(sellerA,'seller-a','verified'); await seedSeller(sellerB,'seller-b','verified'); await seedSeller(pendingSeller,'seller-pending','pending');
  await submission('pending-verification','seller-pending');
});
after(async () => { await mf?.dispose(); });

test('role migration preserves referenced legacy data and assigns least-privilege ownership', async () => {
  assert.deepEqual(await db.prepare("SELECT role,role_chosen FROM auth_users WHERE id='legacy-user'").first(),{role:'seller',role_chosen:1});
  assert.equal((await db.prepare("SELECT status FROM sellers WHERE id='legacy-seller'").first()).status,'pending');
  assert.equal((await db.prepare("SELECT seller_id FROM foods WHERE id='legacy-food'").first()).seller_id,'legacy-seller');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
});

test('authorization matrix: public reads; buyer/seller/admin routes fail closed', async () => {
  for (const cookie of ['',buyer.cookie,sellerA.cookie,sellerB.cookie,pendingSeller.cookie]) {
    assert.equal((await request('/api/admin/verifications',cookie)).status,403);
    assert.equal((await request('/api/admin/verifications/pending-verification/documents/identity',cookie)).status,403);
    assert.equal((await request('/api/admin/decision',cookie,{id:'pending-verification',status:'verified',note:'ok',eligibility:'adult'})).status,403);
  }
  for (const cookie of ['',buyer.cookie,admin.cookie]) {
    assert.equal((await request('/api/seller/dashboard',cookie)).status,403);
    assert.equal((await request('/api/seller/profile',cookie,{})).status,403);
    assert.equal((await request('/api/seller/photos',cookie,new FormData())).status,403);
  }
  for (const cookie of ['',sellerA.cookie,admin.cookie]) {
    assert.equal((await request('/api/buyer/interest',cookie,{foodId:'food-seller-a',interested:true})).status,403);
    assert.equal((await request('/api/buyer/review',cookie,{foodId:'food-seller-a',rating:5,name:'Test',body:'Good'})).status,403);
  }
  assert.equal((await request('/api/buyer/interest',buyer.cookie,{foodId:'food-seller-a',interested:true})).status,200);
  assert.equal((await request('/api/buyer/review',buyer.cookie,{foodId:'food-seller-a',rating:5,name:'Test',body:'Good'})).status,200);
  assert.equal((await request('/api/admin/verifications',admin.cookie)).status,200);
  const image = await request('/api/admin/verifications/pending-verification/documents/identity',admin.cookie);
  assert.equal(image.status,200); assert.equal(image.headers.get('cache-control'),'private, no-store'); assert.equal(image.headers.get('content-type'),'image/png');
});

test('public and seller projections exclude private data and stored keys', async () => {
  const response = await request('/api/public/catalogue','');
  assert.equal(response.status,200); const publicData = await response.json();
  assert.deepEqual(publicData.foods.map(f=>f.seller_id).sort(),['seller-a','seller-b']);
  const dashboard = await (await request('/api/seller/dashboard',pendingSeller.cookie)).json();
  const forbidden = /private-nid|private-home|private@example|private-phone|identity_key|passport_key|selling_key|nid_number|home_address|personal_email|personal_phone|evidence\//;
  assert.doesNotMatch(JSON.stringify(publicData),forbidden); assert.doesNotMatch(JSON.stringify(dashboard),forbidden);
  assert.equal(dashboard.submission.id,'pending-verification');
  assert.equal((await request('/api/public/photos/food-seller-pending','')).status,404);
  assert.equal((await request('/api/buyer/interest',buyer.cookie,{foodId:'food-seller-pending',interested:true})).status,404);
});

test('seller ownership is enforced for edits and photo retrieval', async () => {
  await bucket.put('food/seller-b/22222222-2222-4222-8222-222222222222.png','seller-b-only');
  const food = {id:'food-seller-b',name:'Hacked',description:'No',price:1,category:'Other',image:'/api/seller/photos/11111111-1111-4111-8111-111111111111',available:true};
  assert.equal((await request('/api/seller/food',sellerA.cookie,food)).status,403);
  const original = await db.prepare('SELECT name FROM foods WHERE id=?').bind(food.id).first(); assert.equal(original.name,'Rice');
  assert.equal((await request('/api/seller/food',sellerB.cookie,{...food,name:'Updated'})).status,200);
  assert.equal((await request('/api/seller/profile',sellerA.cookie,{id:'seller-b',name:'Wrong',bio:'Food',address:'Here',lat:1,lng:1,hours:'Noon'})).status,400);
  assert.equal((await request('/api/seller/photos/22222222-2222-4222-8222-222222222222',sellerA.cookie)).status,404);
  assert.equal(await (await request('/api/seller/photos/22222222-2222-4222-8222-222222222222',sellerB.cookie)).text(),'seller-b-only');
  assert.equal((await request('/api/seller/food',pendingSeller.cookie,food)).status,403);
});

test('adult applicants can submit; sellers receive status rather than private fields', async () => {
  const applicant = await account('adultapplicant','seller');
  await request('/api/seller/profile',applicant.cookie,{name:'Adult seller',bio:'Food',address:'Pickup',lat:23,lng:90,hours:'Noon'});
  const fields = new FormData();
  for (const [key,value] of Object.entries({legalName:'Adult Applicant',age:'18',gender:'Other',personalEmail:'private-adult@example.com',personalPhone:'+8801700000000',nidNumber:'1234567890',homeAddress:'Private home',placeAddress:'Pickup',placeLat:'23',placeLng:'90',note:'Home cooking',locationConsent:'on'})) fields.set(key,value);
  for (const key of ['identity','passport','selling']) fields.set(key,new Blob([fixture],{type:'image/png'}),'test.png');
  const response = await request('/api/seller/verification',applicant.cookie,fields);
  assert.equal(response.status,200,await response.clone().text());
  const dashboard = await (await request('/api/seller/dashboard',applicant.cookie)).json();
  assert.equal(dashboard.submission.status,'pending');
  assert.doesNotMatch(JSON.stringify(dashboard),/1234567890|private-adult@example|Private home|identity_key|passport_key/);
  assert.equal((await request('/api/seller/verification',applicant.cookie,fields)).status,409);
});

test('under-18 submission rejected before storage; new profile is pending and hidden', async () => {
  const applicant = await account('youngseller','seller');
  assert.equal((await request('/api/seller/profile',applicant.cookie,{name:'Young seller',bio:'Food',address:'Pickup',lat:23,lng:90,hours:'Noon'})).status,200);
  const dashboard = await (await request('/api/seller/dashboard',applicant.cookie)).json(); assert.equal(dashboard.seller.status,'pending');
  const before = await bucket.list();
  const fields = new FormData(); fields.set('legalName','Young applicant'); fields.set('age','17');
  const response = await request('/api/seller/verification',applicant.cookie,fields);
  assert.equal(response.status,400); assert.match(await response.text(),/at least 18/);
  assert.equal((await bucket.list()).objects.length,before.objects.length);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_verifications WHERE seller_id=?').bind(dashboard.seller.id).first()).n,0);
});

test('age evidence cannot be overridden; only admin decisions update pending sellers', async () => {
  await db.prepare("UPDATE seller_verifications SET age=17 WHERE id='pending-verification'").run();
  const response = await request('/api/admin/decision',admin.cookie,{id:'pending-verification',status:'verified',note:'Attempt approval',eligibility:'adult'});
  assert.equal(response.status,200); assert.equal((await response.json()).status,'rejected');
  assert.equal((await db.prepare("SELECT status FROM sellers WHERE id='seller-pending'").first()).status,'rejected');
  assert.equal((await request('/api/public/photos/food-seller-pending','')).status,404);
  await submission('adult-verification','seller-pending',25);
  await db.prepare("UPDATE sellers SET status='pending' WHERE id='seller-pending'").run();
  assert.equal((await request('/api/admin/decision',admin.cookie,{id:'adult-verification',status:'verified',note:'Checked',eligibility:'unconfirmed'})).status,400);
  assert.equal((await request('/api/admin/decision',admin.cookie,{id:'adult-verification',status:'verified',note:'Checked',eligibility:'adult'})).status,200);
  assert.equal((await request('/api/admin/decision',admin.cookie,{id:'adult-verification',status:'rejected',note:'Again',eligibility:'adult'})).status,409);
});

test('signup cannot set admin; authenticated onboarding chooses buyer/seller only once', async () => {
  for (const fields of [{role:'admin'},{roleChosen:true},{signupRole:'admin'}]) {
    assert.equal((await request('/api/auth/sign-up/email','',{name:'Attack',email:'attack@example.com',password:'A strong test password 42',...fields})).status,400);
  }
  const onboarding = await account('onboarding');
  // Emulate the DB state of a newly verified Google user, without bypassing sessions.
  await db.prepare('UPDATE auth_users SET role_chosen=0 WHERE id=?').bind(onboarding.id).run();
  assert.equal((await request('/api/buyer/interests',onboarding.cookie)).status,403);
  assert.equal((await request('/api/account/role',onboarding.cookie,{role:'admin'})).status,400);
  const results = await Promise.all([request('/api/account/role',onboarding.cookie,{role:'seller'}),request('/api/account/role',onboarding.cookie,{role:'buyer'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await request('/api/account/role',buyer.cookie,{role:'seller'})).status,409);
  assert.equal((await request('/api/account/role','',{role:'seller'})).status,401);
});

test('current DB role overrides stale sessions and forged role headers; mutations require origin', async () => {
  assert.equal((await request('/api/admin/verifications',buyer.cookie,undefined,{'x-role':'admin','oai-authenticated-user-id':admin.id})).status,403);
  assert.equal((await request('/api/seller/profile',sellerA.cookie,{}, {Origin:'https://attacker.test'})).status,403);
  await db.prepare("UPDATE auth_users SET role='buyer' WHERE id=?").bind(sellerA.id).run();
  assert.equal((await request('/api/seller/dashboard',sellerA.cookie)).status,403);
});

test('operator provisioning requires verified accounts and revokes their existing sessions', async () => {
  const candidate = await account('operatorcandidate');
  await db.prepare('UPDATE auth_users SET email_verified=0 WHERE id=?').bind(candidate.id).run();
  await db.batch(adminProvisionStatements(candidate.id).map(sql=>db.prepare(sql)));
  assert.equal((await db.prepare('SELECT role FROM auth_users WHERE id=?').bind(candidate.id).first()).role,'buyer');
  await db.prepare('UPDATE auth_users SET email_verified=1 WHERE id=?').bind(candidate.id).run();
  await db.batch(adminProvisionStatements(candidate.id).map(sql=>db.prepare(sql)));
  assert.equal((await db.prepare('SELECT role FROM auth_users WHERE id=?').bind(candidate.id).first()).role,'admin');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE user_id=?').bind(candidate.id).first()).n,0);
  assert.throws(()=>adminProvisionStatements("user'; DELETE FROM auth_users;--"));
});

function fieldsFor({consent=true,portrait=false,age='24',photo=fixture,type='image/png'}={}) {
  const fields = new FormData();
  for (const [key,value] of Object.entries({legalName:'Private Applicant',age,gender:'Other',personalEmail:'sensitive@example.com',personalPhone:'+8801700000000',nidNumber:'1234567890123',homeAddress:'Never public home',placeAddress:'Public pickup point',placeLat:'23.5',placeLng:'90.5',note:'Prepared fresh'})) fields.set(key,value);
  if(consent) fields.set('locationConsent','on');
  if(portrait) fields.set('portraitConsent','on');
  for(const name of ['identity','passport','selling']) fields.set(name,new Blob([photo],{type}),'upload');
  return fields;
}
async function applicant(name) {
  const a=await account(name,'seller');
  assert.equal((await request('/api/seller/profile',a.cookie,{name,bio:'Food',address:'Pickup',lat:23,lng:90,hours:'Noon'})).status,200);
  a.seller=(await db.prepare('SELECT id FROM sellers WHERE owner=?').bind(a.id).first()).id;
  return a;
}
async function submit(a,fields=fieldsFor()) {
  const response=await request('/api/seller/verification',a.cookie,fields);
  assert.equal(response.status,200,await response.clone().text());
  return (await db.prepare('SELECT id FROM seller_verifications WHERE seller_id=? ORDER BY created DESC').bind(a.seller).first()).id;
}
async function decision(id,status='verified') {
  const r=await request('/api/admin/decision',admin.cookie,{id,status,note:'Reviewed',eligibility:'adult'});
  assert.equal(r.status,200,await r.clone().text());
}
async function cleanup(now,fail=false) {return (await mf.dispatchFetch(origin+'/test/cleanup',{method:'POST',body:JSON.stringify({now,fail})})).json()}

test('required location consent and adult eligibility run before any document storage', async()=>{
  const a=await applicant('consentchecks'); const count=(await privateBucket.list()).objects.length;
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({consent:false}))).status,400);
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({age:'17'}))).status,400);
  assert.equal((await privateBucket.list()).objects.length,count);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_verifications WHERE seller_id=?').bind(a.seller).first()).n,0);
});

test('JPEG/PNG real decoding rejects malformed, oversized, mismatched and excessive dimensions',async()=>{
  const a=await applicant('invalidimages');
  for(const photo of [Buffer.from([255,216,255,224,0,0]),Buffer.alloc(5*1024*1024+1)]) {
    assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({photo,type:'image/jpeg'}))).status,400);
  }
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({type:'image/jpeg'}))).status,400);
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({type:'image/webp'}))).status,400);
  const huge=await sharp({create:{width:8193,height:1,channels:3,background:'#ffffff'}}).png().toBuffer();
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({photo:huge}))).status,400);
  const corrupt=Buffer.from(fixture);corrupt.fill(0,45,50);
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({photo:corrupt}))).status,400);
});

test('all stored images are decoded, oriented, re-encoded and free of ancillary metadata',async()=>{
  const a=await applicant('metadatachecks');
  const original=await sharp({create:{width:8,height:5,channels:3,background:'#228833'}}).withMetadata({orientation:6}).withExifMerge({IFD0:{Artist:'PRIVATE CAMERA',ImageDescription:'GPS private location'}}).jpeg().toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const id=await submit(a,fieldsFor({photo:original,type:'image/jpeg',portrait:true}));
  const record=await db.prepare('SELECT * FROM seller_verifications WHERE id=?').bind(id).first();
  assert.notEqual(record.nid_ciphertext,'1234567890123');assert.equal(Buffer.from(record.nid_iv,'base64').length,12);
  assert.equal(record.location_notice_version,'2026-09-21-v1');assert.equal(record.portrait_consent,1);
  assert.doesNotMatch(JSON.stringify(record),/1234567890123/);
  await decision(id);
  const files=(await db.prepare('SELECT bucket,object_key FROM verification_files WHERE submission_id=?').bind(id).all()).results;
  assert.equal(files.length,5);
  for(const f of files){
    const b=Buffer.from(await (await (f.bucket==='private'?privateBucket:bucket).get(f.object_key)).arrayBuffer());
    const meta=await sharp(b).metadata();assert.equal(meta.width,5);assert.equal(meta.height,8);assert.equal(meta.exif,undefined);assert.equal(meta.icc,undefined);assert.equal(meta.xmp,undefined);assert.equal(meta.orientation,undefined);
    let offset=8;while(offset<b.length){const len=b.readUInt32BE(offset);assert.ok(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(b.toString('ascii',offset+4,offset+8)));offset+=len+12;}
  }
  const foodForm=new FormData();foodForm.set('photo',new Blob([original],{type:'image/jpeg'}),'food.jpg');
  const uploaded=await request('/api/seller/photos',a.cookie,foodForm);assert.equal(uploaded.status,200);
  const foodBytes=await (await request((await uploaded.json()).image,a.cookie)).arrayBuffer();assert.equal((await sharp(Buffer.from(foodBytes)).metadata()).exif,undefined);
});

test('private bucket documents cannot be retrieved through public or seller routes; views are audited',async()=>{
  const a=await applicant('privateaccess');const id=await submit(a);
  const file=await db.prepare("SELECT object_key FROM verification_files WHERE submission_id=? AND kind='nid'").bind(id).first();
  assert.equal(await bucket.get(file.object_key),null);
  for(const cookie of ['',buyer.cookie,a.cookie,sellerB.cookie]) assert.equal((await request(`/api/admin/verifications/${id}/documents/identity`,cookie)).status,403);
  for(const path of ['/api/public/'+file.object_key,'/api/seller/'+file.object_key,`/api/public/sellers/${a.seller}/portrait`,`/api/public/sellers/${a.seller}/place`]) assert.equal((await request(path,a.cookie)).status,404);
  const image=await request(`/api/admin/verifications/${id}/documents/identity`,admin.cookie);assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'private, no-store');
  const queue=await (await request('/api/admin/verifications',admin.cookie)).json();assert.equal(queue.queue.find(v=>v.id===id).nid_number,'1234567890123');assert.doesNotMatch(JSON.stringify(queue),/object_key|nid_ciphertext|nid_iv/);
  const events=(await db.prepare('SELECT * FROM audit_log WHERE subject=?').bind(a.seller).all()).results;assert.ok(events.some(e=>e.action==='document_viewed'));assert.ok(events.some(e=>e.action==='verification_viewed'));
  assert.doesNotMatch(JSON.stringify(events),/sensitive@example|1234567890123|Never public|nid\//);
  const dashboard=await (await request('/api/seller/dashboard',a.cookie)).text();assert.doesNotMatch(dashboard,/sensitive@example|1234567890123|Never public|object_key|ciphertext|nid_iv|passport_key/);
});

test('portrait consent is independent; withdrawal blocks access immediately and queues only the public copy',async()=>{
  const a=await applicant('portraityes');const id=await submit(a,fieldsFor({portrait:true}));await decision(id);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,200);
  assert.equal((await request('/api/seller/portrait/withdraw',a.cookie,{})).status,200);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,404);
  assert.equal((await request(`/api/public/sellers/${a.seller}/place`)).status,200);
  await cleanup(new Date().toISOString());
  const files=(await db.prepare('SELECT kind,state,object_key FROM verification_files WHERE submission_id=?').bind(id).all()).results;
  assert.equal(files.find(f=>f.kind==='portrait').object_key,null);assert.equal(files.find(f=>f.kind==='passport').state,'attached');
  assert.equal((await db.prepare('SELECT status FROM sellers WHERE id=?').bind(a.seller).first()).status,'verified');
  const b=await applicant('portraitno');const bid=await submit(b);await decision(bid);
  assert.equal((await request(`/api/public/sellers/${b.seller}/portrait`)).status,404);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM verification_files WHERE submission_id=? AND kind='portrait'").bind(bid).first()).n,0);
});

test('approval deletes only NID at day 30; keeps passport, encrypted NID and approval record',async()=>{
  const a=await applicant('approvedretention');const id=await submit(a);await decision(id);
  const v=await db.prepare('SELECT reviewed_at,retention_due_at FROM seller_verifications WHERE id=?').bind(id).first();
  assert.equal(Date.parse(v.retention_due_at)-Date.parse(v.reviewed_at),30*86400000);
  await cleanup(new Date(Date.parse(v.retention_due_at)-1).toISOString());
  assert.equal((await db.prepare("SELECT state FROM verification_files WHERE submission_id=? AND kind='nid'").bind(id).first()).state,'attached');
  await cleanup(v.retention_due_at);await cleanup(v.retention_due_at);
  const docs=(await db.prepare('SELECT kind,state,object_key,deleted_at FROM verification_files WHERE submission_id=?').bind(id).all()).results;
  assert.equal(docs.find(d=>d.kind==='nid').object_key,null);assert.ok(docs.find(d=>d.kind==='nid').deleted_at);
  assert.equal(docs.find(d=>d.kind==='passport').state,'attached');assert.equal(docs.find(d=>d.kind==='place').state,'attached');
  assert.ok((await db.prepare('SELECT nid_ciphertext FROM seller_verifications WHERE id=?').bind(id).first()).nid_ciphertext);
});

test('rejection deadline remains tied to old submission after resubmission; deletes every old document',async()=>{
  const a=await applicant('rejectionretention');const id=await submit(a);await decision(id,'rejected');
  const due=(await db.prepare('SELECT retention_due_at FROM seller_verifications WHERE id=?').bind(id).first()).retention_due_at;
  const fresh=await submit(a);assert.notEqual(id,fresh);
  assert.equal((await db.prepare('SELECT retention_due_at FROM seller_verifications WHERE id=?').bind(id).first()).retention_due_at,due);
  await cleanup(due);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM verification_files WHERE submission_id=? AND object_key IS NOT NULL').bind(id).first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM verification_files WHERE submission_id=? AND object_key IS NOT NULL').bind(fresh).first()).n,3);
  assert.equal((await db.prepare('SELECT decision_note FROM seller_verifications WHERE id=?').bind(id).first()).decision_note,'Reviewed');
});

test('account deletion revokes access and erases structured data; failed object deletions remain retryable',async()=>{
  const a=await applicant('accountcleanup');const id=await submit(a,fieldsFor({portrait:true}));await decision(id);
  const files=(await db.prepare('SELECT object_key,bucket FROM verification_files WHERE subject=?').bind(a.seller).all()).results;
  const r=await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:a.id,fail:true})});const result=await r.json();
  assert.equal(result.dataDeleted,true);assert.equal(result.filesPending,3);
  assert.equal((await request('/api/seller/dashboard',a.cookie)).status,403);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,404);
  assert.equal((await request(`/api/admin/verifications/${id}/documents/identity`,admin.cookie)).status,404);
  for(const [table,column,value] of [['seller_verifications','seller_id',a.seller],['auth_users','id',a.id],['auth_accounts','user_id',a.id],['auth_sessions','user_id',a.id]])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).bind(value).first()).n,0);
  await cleanup(new Date(Date.now()+120000).toISOString());
  for(const f of files)assert.equal(await (f.bucket==='private'?privateBucket:bucket).get(f.object_key),null);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM verification_files WHERE subject=?').bind(a.seller).first()).n,0);
  const audit=(await db.prepare('SELECT * FROM audit_log WHERE subject=?').bind(a.seller).all()).results;assert.ok(audit.some(e=>e.action==='account_deleted'));assert.doesNotMatch(JSON.stringify(audit),/accountcleanup|sensitive@example|1234567890123|Never public|object_key/);
});

test('concurrent submission/decision races leave one decision and retryable orphan cleanup',async()=>{
  const a=await applicant('submissionrace');
  const attempts=await Promise.all([request('/api/seller/verification',a.cookie,fieldsFor()),request('/api/seller/verification',a.cookie,fieldsFor())]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const id=(await db.prepare('SELECT id FROM seller_verifications WHERE seller_id=?').bind(a.seller).first()).id;
  const decisions=await Promise.all([request('/api/admin/decision',admin.cookie,{id,status:'verified',note:'Approved',eligibility:'adult'}),request('/api/admin/decision',admin.cookie,{id,status:'rejected',note:'Rejected',eligibility:'adult'})]);assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE subject=? AND action IN ('verified','rejected')").bind(a.seller).first()).n,1);
  await cleanup(new Date(Date.now()+2*3600000).toISOString());
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM verification_files WHERE subject=? AND state='staging'").bind(a.seller).first()).n,0);
});
