import { createHmac } from 'node:crypto';
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
function otp(secret,counter=Math.floor(Date.now()/30000)) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const bytes=[];
  for(const c of secret){value=(value<<5)|alphabet.indexOf(c);bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
  const message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));const hash=createHmac('sha1',Buffer.from(bytes)).update(message).digest();const offset=hash[19]&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
async function enroll(a) {
  const setup=await request('/api/admin/mfa/enroll',a.cookie,{});assert.equal(setup.status,200,await setup.clone().text());
  a.secret=(await setup.json()).secret;
  a.enrollmentCode=otp(a.secret);
  const confirm=await request('/api/admin/mfa/confirm',a.cookie,{code:a.enrollmentCode});assert.equal(confirm.status,200,await confirm.clone().text());
  a.recoveryCodes=(await confirm.json()).recoveryCodes;return a;
}
async function newAdmin(name) {const a=await account(name);await db.prepare("UPDATE auth_users SET role='admin' WHERE id=?").bind(a.id).run();return a;}
async function loginAgain(name) {const r=await request('/api/auth/sign-in/email','',{email:`${name}@example.com`,password:'A test-only strong password 42'});assert.equal(r.status,200);return r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}
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
  mf = new Miniflare({ modules: true, scriptPath: '.wrangler/role-tests/worker.mjs', compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET','PRIVATE_VERIFICATIONS'], images: {binding:'IMAGES'}, bindings: { TEST_ONLY_BETTER_AUTH:'true', NID_ENCRYPTION_KEYS: JSON.stringify({v1:Buffer.alloc(32,7).toString('base64')}), AUTH_BASE_URL: origin, BETTER_AUTH_SECRET: 'test-only-secret-with-more-than-thirty-two-characters', RESEND_API_KEY: 'fake', AUTH_EMAIL_FROM: 'test@foodlane.test' } });
  db = await mf.getD1Database('DB'); bucket = await mf.getR2Bucket('BUCKET'); privateBucket = await mf.getR2Bucket('PRIVATE_VERIFICATIONS');
  for (const file of (await readdir('drizzle')).filter(f => f.endsWith('.sql')).sort()) {
    if (file.startsWith('0005_')) {
      await db.prepare("INSERT INTO auth_users(id,name,email,email_verified,created_at,updated_at) VALUES('legacy-user','Legacy','legacy@example.com',1,0,0)").run();
      await db.prepare("INSERT INTO sellers VALUES('legacy-seller','legacy-user','Legacy','','Food','Pickup',23,90,'Noon','unverified','2026-01-01')").run();
      await db.prepare("INSERT INTO foods VALUES('legacy-food','legacy-seller','Rice','Fresh',100,'Other','old-key',1)").run();
    }
    if(file.startsWith('0008_')){
      await db.prepare("INSERT INTO auth_users(id,name,email,email_verified,role,role_chosen,created_at,updated_at) VALUES('legacy-buyer','Buyer','migration@example.com',1,'buyer',1,0,0)").run();
      await db.prepare("INSERT INTO foods VALUES('legacy-food-2','legacy-seller','Rice 2','Fresh',100,'Other','',0)").run();
      await db.prepare("INSERT INTO interests VALUES('legacy-food','legacy-buyer'),('legacy-food-2','legacy-buyer')").run();
      await db.prepare("INSERT INTO reviews VALUES('legacy-food','legacy-buyer','Buyer',1,'Earlier','2026-01-01'),('legacy-food-2','legacy-buyer','Buyer',5,'Latest','2026-01-02')").run();
    }
    const sql = await readFile('drizzle/' + file, 'utf8');
    await db.batch(sql.split(';').map(s => s.replaceAll('--> statement-breakpoint', '').trim()).filter(Boolean).map(s => db.prepare(s)));
  }
  buyer = await account('rolebuyer'); sellerA = await account('sellera','seller'); sellerB = await account('sellerb','seller');
  pendingSeller = await account('pending','seller'); admin = await account('admin');
  await db.prepare("UPDATE auth_users SET role='admin' WHERE id=?").bind(admin.id).run();
  await enroll(admin);
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

test('engagement migration merges food interests and keeps the latest review per buyer per seller',async()=>{
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM seller_interests WHERE seller_id='legacy-seller'").first()).n,1);
  assert.deepEqual(await db.prepare("SELECT rating,body,created,updated FROM seller_reviews WHERE seller_id='legacy-seller'").first(),{rating:5,body:'Latest',created:'2026-01-02',updated:'2026-01-02'});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM interests').first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM reviews').first()).n,0);
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
    assert.equal((await request('/api/buyer/interest',cookie,{sellerId:'seller-a'})).status,403);
    assert.equal((await request('/api/buyer/review',cookie,{sellerId:'seller-a',rating:5,body:'Good'})).status,403);
  }
  assert.equal((await request('/api/buyer/interest',buyer.cookie,{sellerId:'seller-a'})).status,200);
  assert.equal((await request('/api/buyer/review',buyer.cookie,{sellerId:'seller-a',rating:5,body:'Good'})).status,200);
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
  assert.equal((await request('/api/buyer/interest',buyer.cookie,{sellerId:'seller-pending'})).status,404);
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

test('signup cannot set admin; onboarding collects buyer mobile and chooses role only once', async () => {
  for (const fields of [{role:'admin'},{roleChosen:true},{signupRole:'admin'}]) {
    assert.equal((await request('/api/auth/sign-up/email','',{name:'Attack',email:'attack@example.com',password:'A strong test password 42',...fields})).status,400);
  }
  const onboarding = await account('onboarding');
  await db.prepare('UPDATE auth_users SET role_chosen=0 WHERE id=?').bind(onboarding.id).run();
  assert.equal((await request('/api/buyer/interests',onboarding.cookie)).status,403);
  const adminForm=new FormData();adminForm.set('role','admin');adminForm.set('name','Onboarding Name');
  assert.equal((await request('/api/account/role',onboarding.cookie,adminForm)).status,400);
  const roleForm=(role,phone)=>{const form=new FormData();form.set('role',role);form.set('name','Foodlane Name');form.set('phone',phone);form.set('useGooglePhoto','true');return form;};
  const results = await Promise.all([request('/api/account/role',onboarding.cookie,roleForm('seller','')),request('/api/account/role',onboarding.cookie,roleForm('buyer','+880 1712 345678'))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const chosen=await db.prepare('SELECT name,role,phone FROM auth_users WHERE id=?').bind(onboarding.id).first();
  assert.equal(chosen.name,'Foodlane Name');assert.ok(['buyer','seller'].includes(chosen.role));
  if(chosen.role==='buyer')assert.equal(chosen.phone,'+880 1712 345678');else assert.equal(chosen.phone,null);
  const profileForm=new FormData();profileForm.set('role','buyer');profileForm.set('name','Buyer profile');profileForm.set('phone','+8801712345678');
  assert.equal((await request('/api/account/role',onboarding.cookie,profileForm)).status,409);
  const tooShort=new FormData();tooShort.set('role','buyer');tooShort.set('name','Valid Name');tooShort.set('phone','123');
  const another=await account('onboardmissing');await db.prepare('UPDATE auth_users SET role_chosen=0 WHERE id=?').bind(another.id).run();
  assert.equal((await request('/api/account/role',another.cookie,tooShort)).status,400);
  assert.equal((await request('/api/account/role',buyer.cookie,roleForm('seller',''))).status,409);
  assert.equal((await request('/api/account/role','',roleForm('seller',''))).status,401);
});

test('account profile updates name and phone and stores replaceable private photos',async()=>{
  const a=await account('profileedit');
  const update=new FormData();update.set('name','Updated Buyer');update.set('phone','+880 1712 345678');
  assert.equal((await request('/api/account/profile',a.cookie,update)).status,200);
  let me=await (await request('/api/account/me',a.cookie)).json();assert.equal(me.user.name,'Updated Buyer');assert.equal(me.user.phone,'+880 1712 345678');
  const upload=async()=>{const data=new FormData();data.set('name','Updated Buyer');data.set('phone','+880 1712 345678');data.set('profilePhoto',new File([fixture],'profile.png',{type:'image/png'}));return request('/api/account/profile',a.cookie,data);};
  assert.equal((await upload()).status,200);
  me=await (await request('/api/account/me',a.cookie)).json();assert.equal(me.user.image,'/api/account/profile-photo');
  const key=(await db.prepare('SELECT image FROM auth_users WHERE id=?').bind(a.id).first()).image;assert.ok(key.startsWith('profile/'+a.id+'/'));
  assert.equal((await request('/api/account/profile-photo',a.cookie)).status,200);
  const firstKey=key;assert.equal((await upload()).status,200);
  assert.equal((await db.prepare("SELECT kind FROM verification_files WHERE object_key=?").bind(firstKey).first()).kind,'account-delete');
  const remove=new FormData();remove.set('name','Updated Buyer');remove.set('phone','+880 1712 345678');remove.set('removePhoto','true');
  assert.equal((await request('/api/account/profile',a.cookie,remove)).status,200);
  assert.equal((await db.prepare('SELECT image FROM auth_users WHERE id=?').bind(a.id).first()).image,null);
  assert.equal((await request('/api/account/profile-photo',a.cookie)).status,404);
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
  assert.equal((await (await request(`/api/public/sellers/${a.seller}`)).json()).seller.portrait,`/api/public/sellers/${a.seller}/portrait`);
  assert.equal((await request('/api/seller/portrait/withdraw',a.cookie,{})).status,200);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,404);
  assert.equal((await (await request(`/api/public/sellers/${a.seller}`)).json()).seller.portrait,null);
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
  assert.equal((await request('/api/buyer/interest',buyer.cookie,{sellerId:a.seller})).status,200);
  assert.equal((await request('/api/buyer/review',buyer.cookie,{sellerId:a.seller,rating:5,body:'Test'})).status,200);
  const files=(await db.prepare('SELECT object_key,bucket FROM verification_files WHERE subject=?').bind(a.seller).all()).results;
  const r=await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:a.id,fail:true})});const result=await r.json();
  assert.equal(result.dataDeleted,true);assert.equal(result.filesPending,3);
  assert.equal((await request('/api/seller/dashboard',a.cookie)).status,403);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,404);
  assert.equal((await request(`/api/public/sellers/${a.seller}`)).status,404);
  assert.equal((await request(`/api/admin/verifications/${id}/documents/identity`,admin.cookie)).status,404);
  for(const [table,column,value] of [['seller_interests','seller_id',a.seller],['seller_reviews','seller_id',a.seller],['seller_verifications','seller_id',a.seller],['auth_users','id',a.id],['auth_accounts','user_id',a.id],['auth_sessions','user_id',a.id]])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).bind(value).first()).n,0);
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


test('all admin APIs deny admins without session MFA, including Google-origin sessions',async()=>{
  const a=await newAdmin('mfarequired');
  // Model the account returned after a verified Google callback. The authorization
  // gate is provider-independent and must not trust the provider as local MFA.
  await db.prepare("UPDATE auth_accounts SET provider_id='google',password=NULL WHERE user_id=?").bind(a.id).run();
  for(const path of ['/api/admin/verifications','/api/admin/audit','/api/admin/verifications/guessed/documents/identity'])assert.equal((await request(path,a.cookie)).status,403);
  assert.equal((await request('/api/admin/decision',a.cookie,{id:'guessed',status:'verified',note:'Checked',eligibility:'adult'})).status,403);
  await enroll(a);
  assert.equal((await request('/api/admin/audit',a.cookie)).status,200);
  for(const c of ['',buyer.cookie,sellerB.cookie])for(const endpoint of ['status','enroll','confirm','verify','recover'])assert.equal((await request('/api/admin/mfa/'+endpoint,c,endpoint==='status'?undefined:{})).status,403);
});

test('MFA proof belongs to one session, expires, and cannot be forged in headers',async()=>{
  const a=await enroll(await newAdmin('sessionmfa'));const second=await loginAgain('sessionmfa');
  assert.equal((await request('/api/admin/audit',second,undefined,{'x-mfa-verified':'true'})).status,403);
  assert.equal((await request('/api/admin/mfa/verify',second,{code:a.enrollmentCode})).status,403,'enrollment code is not reusable');
  assert.equal((await request('/api/admin/mfa/recover',second,{code:a.recoveryCodes[0]})).status,200);
  assert.equal((await request('/api/admin/audit',second)).status,200);
  await db.prepare('UPDATE admin_mfa_sessions SET expires_at=0 WHERE user_id=?').bind(a.id).run();
  assert.equal((await request('/api/admin/audit',a.cookie)).status,403);
  assert.equal((await request('/api/admin/audit',second)).status,403);
});

test('recovery codes are hashed, single-use under concurrency, and scoped to the account',async()=>{
  const a=await enroll(await newAdmin('recovermfa')),second=await loginAgain('recovermfa');
  const stored=await db.prepare('SELECT digest FROM admin_recovery_codes WHERE user_id=?').bind(a.id).all();assert.equal(stored.results.length,10);
  for(const code of a.recoveryCodes)assert.doesNotMatch(JSON.stringify(stored),new RegExp(code));
  const attempts=await Promise.all([request('/api/admin/mfa/recover',second,{code:a.recoveryCodes[0]}),request('/api/admin/mfa/recover',second,{code:a.recoveryCodes[0]})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,403]);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_recovery_codes WHERE user_id=?').bind(a.id).first()).n,9);
  const b=await enroll(await newAdmin('othermfafactor'));assert.equal((await request('/api/admin/mfa/recover',b.cookie,{code:a.recoveryCodes[1]})).status,403);
  const secret=await db.prepare('SELECT secret FROM admin_mfa WHERE user_id=?').bind(a.id).first();assert.doesNotMatch(secret.secret,new RegExp(a.secret));
  const audit=await db.prepare('SELECT * FROM audit_log WHERE subject=?').bind(a.id).all();assert.doesNotMatch(JSON.stringify(audit),new RegExp(a.secret+'|'+a.recoveryCodes.join('|')));
});

test('enrollment requires a fresh session, is session-bound, expires and cannot replace an enabled factor',async()=>{
  const a=await newAdmin('setupmfa');
  await db.prepare('UPDATE auth_sessions SET created_at=? WHERE user_id=?').bind(Date.now()-700000,a.id).run();
  assert.equal((await request('/api/admin/mfa/enroll',a.cookie,{})).status,403);
  a.cookie=await loginAgain('setupmfa');
  const setup=await (await request('/api/admin/mfa/enroll',a.cookie,{})).json();const other=await loginAgain('setupmfa');
  assert.equal((await request('/api/admin/mfa/confirm',other,{code:otp(setup.secret)})).status,403);
  await db.prepare('UPDATE admin_mfa SET setup_expires=0 WHERE user_id=?').bind(a.id).run();
  assert.equal((await request('/api/admin/mfa/confirm',a.cookie,{code:otp(setup.secret)})).status,403);
  const b=await enroll(await newAdmin('lockedfactor'));
  assert.equal((await request('/api/admin/mfa/enroll',b.cookie,{})).status,409);
  assert.equal((await request('/api/admin/mfa/disable',b.cookie,{})).status,404);
});

test('MFA retries use persistent account limits and enforce CSRF',async()=>{
  const a=await newAdmin('ratemfa');
  assert.equal((await request('/api/admin/mfa/enroll',a.cookie,{}, {Origin:'https://attacker.test'})).status,403);
  for(let i=0;i<5;i++)assert.equal((await request('/api/admin/mfa/verify',a.cookie,{code:'000000'})).status,403);
  assert.equal((await request('/api/admin/mfa/enroll',a.cookie,{})).status,429);
});

test('audit pagination is bounded, stable across identical timestamps, and excludes private fields',async()=>{
  const all=[];let cursor=null;
  do{const response=await request('/api/admin/audit?limit=3'+(cursor?'&cursor='+encodeURIComponent(cursor):''),admin.cookie);assert.equal(response.status,200);const data=await response.json();assert.ok(data.events.length<=3);all.push(...data.events);cursor=data.nextCursor;}while(cursor);
  assert.equal(new Set(all.map(e=>e.id)).size,all.length);assert.equal(all.length,(await db.prepare('SELECT COUNT(*) n FROM audit_log').first()).n);
  assert.doesNotMatch(JSON.stringify(all),/nid_number|nid_ciphertext|personal_email|personal_phone|object_key|Never public|sensitive@example/);
  for(const q of ['limit=101','limit=-1','cursor=invalid','unknown=yes'])assert.equal((await request('/api/admin/audit?'+q,admin.cookie)).status,400);
});

test('changing business identity/location or place photo requires renewed approval and location consent',async()=>{
  const a=await applicant('renewreview');let id=await submit(a,fieldsFor({portrait:true}));await decision(id);
  assert.equal((await request(`/api/public/sellers/${a.seller}/place`)).status,200);
  assert.equal((await request('/api/seller/verification/reopen',a.cookie,{})).status,200);
  assert.equal((await request(`/api/public/sellers/${a.seller}/place`)).status,404);
  assert.equal((await request(`/api/public/sellers/${a.seller}/portrait`)).status,404);
  assert.equal((await request(`/api/public/sellers/${a.seller}`)).status,404);
  assert.equal((await request('/api/seller/verification',a.cookie,fieldsFor({consent:false}))).status,400);
  id=await submit(a);await decision(id);
  assert.equal((await request(`/api/public/sellers/${a.seller}/place`)).status,200);
  assert.equal((await request('/api/seller/profile',a.cookie,{name:'New business',bio:'Food',address:'New pickup',lat:22,lng:89,hours:'Noon'})).status,200);
  assert.equal((await request(`/api/public/sellers/${a.seller}/place`)).status,404);
});

test('admin rejection requires a reason; simultaneous approvals publish only one set of copies',async()=>{
  const a=await applicant('approvalrace');const id=await submit(a,fieldsFor({portrait:true}));
  assert.equal((await request('/api/admin/decision',admin.cookie,{id,status:'rejected',note:'  ',eligibility:'adult'})).status,400);
  const attempts=await Promise.all([request('/api/admin/decision',admin.cookie,{id,status:'verified',note:'Checked',eligibility:'adult'}),request('/api/admin/decision',admin.cookie,{id,status:'verified',note:'Checked',eligibility:'adult'})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM verification_files WHERE submission_id=? AND bucket='media' AND state='attached'").bind(id).first()).n,2);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE subject=? AND action='verified'").bind(a.seller).first()).n,1);
});


test('logout and account deletion erase MFA session proofs and factor material',async()=>{
  const a=await enroll(await newAdmin('mfaremoval'));
  assert.equal((await request('/api/auth/sign-out',a.cookie,{})).status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_mfa_sessions WHERE user_id=?').bind(a.id).first()).n,0);
  assert.equal((await request('/api/admin/audit',a.cookie)).status,403);
  const response=await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:a.id})});assert.equal(response.status,200);
  for(const table of ['admin_mfa','admin_recovery_codes','admin_mfa_sessions'])assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).bind(a.id).first()).n,0);
});


test('TOTP verification rejects expired codes and atomically consumes a valid code',async()=>{
  const a=await enroll(await newAdmin('totprace')),second=await loginAgain('totprace');
  assert.equal((await request('/api/admin/mfa/verify',second,{code:otp(a.secret,Math.floor(Date.now()/30000)-3)})).status,403);
  const code=otp(a.secret,Math.floor(Date.now()/30000)+1);
  const results=await Promise.all([request('/api/admin/mfa/verify',second,{code}),request('/api/admin/mfa/verify',second,{code})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
  assert.equal((await request('/api/admin/audit',second)).status,200);
});


test('seller engagement is unique under concurrent requests and review editing is explicit and scoped',async()=>{
  const results=await Promise.all(Array.from({length:8},()=>request('/api/buyer/interest',buyer.cookie,{sellerId:'seller-b'})));
  assert.ok(results.every(r=>r.status===200));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM seller_interests WHERE seller_id='seller-b' AND user_id=?").bind(buyer.id).first()).n,1);
  const reviews=await Promise.all(Array.from({length:8},()=>request('/api/buyer/review',buyer.cookie,{sellerId:'seller-b',rating:4,body:'Fresh food'})));
  assert.equal(reviews.filter(r=>r.status===200).length,1);assert.equal(reviews.filter(r=>r.status===409).length,7);
  const second=await account('engagement-second');
  assert.equal((await request('/api/buyer/review/edit',second.cookie,{sellerId:'seller-b',rating:1,body:'Not mine'})).status,404);
  assert.equal((await request('/api/buyer/review/edit',buyer.cookie,{sellerId:'seller-b',rating:3,body:'Updated review'})).status,200);
  const own=await (await request('/api/buyer/reviews/seller-b',buyer.cookie)).json();assert.equal(own.review.rating,3);assert.equal(own.review.body,'Updated review');
  const detail=await (await request('/api/public/sellers/seller-b')).json();assert.equal(detail.seller.rating,3);assert.equal(detail.seller.review_count,1);assert.equal(detail.seller.interest_count,1);
  assert.equal((await (await request('/api/seller/dashboard',sellerB.cookie)).json()).interestCount,1);
  assert.equal((await request('/api/buyer/review',second.cookie,{sellerId:'seller-b',rating:0,body:'bad'})).status,400);
  assert.equal((await request('/api/buyer/review',second.cookie,{sellerId:'seller-b',rating:1.5,body:'bad'})).status,400);
  assert.equal((await request('/api/buyer/interest',second.cookie,{sellerId:'seller-b',userId:buyer.id})).status,400);
  assert.equal((await request('/api/buyer/review/edit',buyer.cookie,{sellerId:'seller-b',rating:3,body:'CSRF'},{Origin:'https://evil.test'})).status,403);
  await request('/api/buyer/interest',second.cookie,{sellerId:'seller-b'});
  await request('/api/buyer/review',second.cookie,{sellerId:'seller-b',rating:5,body:'Mine'});
  await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:second.id})});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_interests WHERE user_id=?').bind(second.id).first()).n,0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_reviews WHERE user_id=?').bind(second.id).first()).n,0);
});

test('near-me exact distance filtering precedes pagination, handles antimeridian/poles and excludes unapproved sellers',async()=>{
  const points=[['geo-near',0,0.01,'verified'],['geo-far',0,0.03,'verified'],['geo-corner',0.04,0.04,'verified'],['geo-west',0,-179.99,'verified'],['geo-east',0,179.98,'verified'],['geo-pole',89.99,150,'verified'],['geo-south',-89.99,-150,'verified'],['geo-pending',0,0,'pending'],['geo-rejected',0,0,'rejected'],['geo-suspended',0,0,'suspended']];
  try {
    for(const [id,lat,lng,status] of points)await db.prepare('INSERT INTO sellers VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,id,id,'private-phone','Food','Public pickup',lat,lng,'Noon',status,'2026-01-01').run();
    const search=async(q)=>{const r=await request('/api/public/sellers?'+q);assert.equal(r.status,200,await r.clone().text());return r.json();};
    const first=await search('lat=0&lng=0&limit=1');assert.equal(first.total,2);assert.equal(first.radius,5);assert.equal(first.sellers[0].id,'geo-near');assert.ok(first.sellers[0].distance_km>1&&first.sellers[0].distance_km<1.2);
    assert.equal((await search('lat=0&lng=0&limit=1&page=2')).sellers[0].id,'geo-far');
    assert.equal((await search('lat=0&lng=0&radius=100')).total,3);
    assert.deepEqual((await search('lat=0&lng=180')).sellers.map(s=>s.id),['geo-west','geo-east']);
    assert.deepEqual((await search('lat=0&lng=-180')).sellers.map(s=>s.id),['geo-west','geo-east']);
    assert.equal((await search('lat=90&lng=0')).sellers[0].id,'geo-pole');
    assert.equal((await search('lat=-90&lng=0')).sellers[0].id,'geo-south');
    assert.equal((await search('lat=0&lng=0&radius=0.1')).total,0);
    const listing=await search('limit=100');assert.ok(listing.sellers.every(s=>s.status==='verified'));
    for(const id of ['geo-pending','geo-rejected','geo-suspended'])assert.equal((await request('/api/public/sellers/'+id)).status,404);
    assert.doesNotMatch(JSON.stringify(listing),/private-phone|nid|personal_email|home_address|object_key|passport|owner/);
    for(const q of ['lat=0','lng=0','lat=91&lng=0','lat=0&lng=181','radius=101','radius=0','lat=&lng=0','lat=NaN&lng=0','page=1.5','limit=101','lat=0&lat=1&lng=0','extra=true'])assert.equal((await request('/api/public/sellers?'+q)).status,400,q);
    assert.equal((await request('/api/public/sellers/geo-near?page=0')).status,400);
  }finally{for(const [id] of points)await db.prepare('DELETE FROM sellers WHERE id=?').bind(id).run();}
});


test('account deletion uses the active session and typed confirmation without email, and stores only an anonymous reason',async()=>{
  const a=await account('deleteconfirmed');
  assert.equal((await request('/api/account/delete',a.cookie,{confirmation:'no'})).status,400);
  assert.equal((await request('/api/account/delete',a.cookie,{confirmation:'DELETE'},{Origin:'https://evil.test'})).status,403);
  const success=await request('/api/account/delete',a.cookie,{confirmation:'DELETE',reason:'privacy'});
  assert.equal(success.status,200,await success.clone().text());assert.equal((await success.json()).filesPending,0);assert.match(success.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await request('/api/account/me',a.cookie)).status,401);
  for(const table of ['auth_users','auth_accounts','auth_sessions','deletion_challenges']){const column=table==='auth_users'?'id':'user_id';assert.equal((await db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE '+column+'=?').bind(a.id).first()).n,0);}
  const feedback=await db.prepare('SELECT reason FROM account_deletion_feedback').first();assert.deepEqual(feedback,{reason:'privacy'});
  const events=await db.prepare("SELECT subject,action FROM audit_log WHERE subject=?").bind(a.id).all();assert.deepEqual(events.results,[{subject:a.id,action:'account_deletion_requested'},{subject:a.id,action:'account_deleted'}]);
});
test('Google users can delete without email and administrators still need MFA',async()=>{
  const google=await account('deletegoogle');await db.prepare("UPDATE auth_accounts SET provider_id='google',password=NULL WHERE user_id=?").bind(google.id).run();
  assert.equal((await request('/api/account/delete',google.cookie,{confirmation:'DELETE'})).status,200);
  const adminDelete=await newAdmin('deletemfa');
  assert.equal((await request('/api/account/delete',adminDelete.cookie,{confirmation:'DELETE'})).status,403);
  await enroll(adminDelete);
  assert.equal((await request('/api/account/delete',adminDelete.cookie,{confirmation:'DELETE'})).status,200);
});

test('public account deletion truthfully returns pending jobs and retries erase every private/public derivative',async()=>{
  const a=await applicant('deletepending');const id=await submit(a,fieldsFor({portrait:true}));await decision(id);
  assert.equal((await request('/api/buyer/report',buyer.cookie,{sellerId:a.seller,reason:'A test report containing private text'})).status,200);
  const files=(await db.prepare('SELECT object_key,bucket FROM verification_files WHERE subject=?').bind(a.seller).all()).results;
  const r=await request('/api/account/delete',a.cookie,{confirmation:'DELETE',reason:'other'},{'x-test-fail-storage':'1'});assert.equal(r.status,202);const result=await r.json();assert.equal(result.dataDeleted,true);assert.equal(result.filesPending,3);
  assert.equal((await request(`/api/public/sellers/${a.seller}`)).status,404);assert.equal((await request(`/api/admin/verifications/${id}/documents/passport`,admin.cookie)).status,404);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_reports WHERE seller_id=?').bind(a.seller).first()).n,0);
  await cleanup(new Date(Date.now()+120000).toISOString());for(const f of files)assert.equal(await (f.bucket==='private'?privateBucket:bucket).get(f.object_key),null);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM verification_files WHERE subject=?').bind(a.seller).first()).n,0);
});
test('buyer reports, atomic admin decisions, suspension bypass resistance and renewed review',async()=>{
  const reporter=await account('reportbuyer');const a=await applicant('reported');const id=await submit(a,fieldsFor({portrait:true}));await decision(id);
  for(const cookie of ['',a.cookie,admin.cookie])assert.equal((await request('/api/buyer/report',cookie,{sellerId:a.seller,reason:'A detailed buyer report'})).status,403);
  assert.equal((await request('/api/buyer/report',reporter.cookie,{sellerId:a.seller,reason:'A detailed buyer report'})).status,200);
  assert.equal((await request('/api/buyer/report',reporter.cookie,{sellerId:a.seller,reason:'Duplicate report'})).status,409);
  const report=await db.prepare('SELECT id FROM seller_reports WHERE seller_id=?').bind(a.seller).first();
  const queue=await request('/api/admin/reports',admin.cookie);assert.equal(queue.status,200);assert.ok((await queue.json()).reports.some(r=>r.id===report.id));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE subject=? AND action='report_viewed' AND admin_ref=?").bind(report.id,admin.id).first()).n,1);
  for(const cookie of ['',reporter.cookie,a.cookie])assert.equal((await request('/api/admin/reports',cookie)).status,403);
  const noMfa=await newAdmin('moderatemfa');assert.equal((await request('/api/admin/reports',noMfa.cookie)).status,403);
  const race=await Promise.all([1,2].map(()=>request('/api/admin/reports/decision',admin.cookie,{id:report.id,action:'suspend',reason:'Business activity needs investigation'})));
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const hidden=async()=>{for(const suffix of ['', '/place','/portrait'])assert.equal((await request(`/api/public/sellers/${a.seller}${suffix}`)).status,404);assert.ok(!(await (await request('/api/public/sellers?limit=100')).json()).sellers.some(s=>s.id===a.seller));};await hidden();
  const dashboard=await (await request('/api/seller/dashboard',a.cookie)).json();assert.equal(dashboard.suspension.reason,'Business activity needs investigation');
  assert.equal((await request('/api/seller/profile',a.cookie,{name:'Changed',bio:'Food',address:'Pickup',lat:23,lng:90,hours:'Noon'})).status,403);
  // Even a stale or racing approval cannot bypass the independent suspension.
  await db.prepare("UPDATE sellers SET status='verified' WHERE id=?").bind(a.seller).run();await hidden();
  assert.equal((await request('/api/buyer/interest',reporter.cookie,{sellerId:a.seller})).status,404);
  await submission('suspended-review',a.seller);await decision('suspended-review');assert.equal((await db.prepare('SELECT status FROM sellers WHERE id=?').bind(a.seller).first()).status,'suspended');await hidden();
  assert.equal((await request('/api/admin/suspensions/lift',admin.cookie,{sellerId:a.seller,reason:'Investigation finished; review again'})).status,200);assert.equal((await db.prepare('SELECT status FROM sellers WHERE id=?').bind(a.seller).first()).status,'pending');await hidden();
  const again=await submit(a);await decision(again);assert.equal((await request(`/api/public/sellers/${a.seller}`)).status,200);
  assert.equal((await request('/api/buyer/report',reporter.cookie,{sellerId:a.seller,reason:'A different detailed report'})).status,200);
  const latest=await db.prepare("SELECT id FROM seller_reports WHERE seller_id=? AND status='open'").bind(a.seller).first();
  assert.equal((await request('/api/admin/reports/decision',admin.cookie,{id:latest.id,action:'dismiss',reason:'No evidence of a policy violation'})).status,200);assert.equal((await request(`/api/public/sellers/${a.seller}`)).status,200);
  const events=(await db.prepare('SELECT action FROM audit_log WHERE subject=?').bind(a.seller).all()).results.map(x=>x.action);assert.ok(events.includes('seller_suspended'));assert.ok(events.includes('suspension_lifted'));assert.ok(events.includes('report_dismissed'));
  assert.equal((await request('/api/buyer/report',reporter.cookie,{sellerId:a.seller,reason:'Too many reports today'})).status,429);
});
test('persistent API limits are atomic and bounded input, HTTPS and CSRF fail closed',async()=>{
  const ip='203.0.113.99',key=createHmac('sha256','test-only-secret-with-more-than-thirty-two-characters').update(`api:ip:${ip}`).digest('hex');
  await db.prepare('INSERT INTO auth_limits(key,count,expires_at) VALUES(?,299,?)').bind(key,Date.now()+60000).run();
  const race=await Promise.all([1,2].map(()=>request('/api/public/sellers','',undefined,{'CF-Connecting-IP':ip})));assert.deepEqual(race.map(r=>r.status).sort(),[200,429]);assert.ok(Number(race.find(r=>r.status===429).headers.get('retry-after'))>0);
  assert.equal((await request('/api/public/sellers','',undefined,{'CF-Connecting-IP':ip})).status,429);
  const a=await account('boundedbuyer');
  assert.equal((await request('/api/buyer/review',a.cookie,{sellerId:'seller-b',rating:5,body:'x'.repeat(17000)})).status,413);
  assert.equal((await request('/api/buyer/review',a.cookie,{sellerId:'seller-b',rating:5,body:'okay'},{'Content-Type':'text/plain'})).status,415);
  assert.equal((await request('/api/buyer/review',a.cookie,[])).status,400);
  assert.equal((await request('/api/buyer/review',a.cookie,{sellerId:'seller-b',rating:5,body:'okay'},{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await mf.dispatchFetch('http://foodlane.test/api/public/sellers')).status,403);
  assert.equal((await request('/api/public/catalogue?unexpected=1')).status,400);
  assert.equal((await request('/api/admin/reports?page=0',admin.cookie)).status,400);
  assert.equal((await request('/api/public/sellers/'+'x'.repeat(101))).status,400);
  const up=await applicant('uploadlimited');await db.prepare('INSERT INTO auth_limits(key,count,expires_at) VALUES(?,10,?)').bind('upload:'+up.id,Date.now()+600000).run();
  const limited=await request('/api/seller/verification',up.cookie,fieldsFor());assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'600');
});


test('account deletion racing a cleanup batch leaves no stale file-job record after deletion succeeds',async()=>{
  const id='cleanup-account-race',key='nid/test-cleanup-race/document.png';await privateBucket.put(key,fixture);
  await db.prepare("INSERT INTO verification_files(id,subject,kind,bucket,object_key,state,created_at,delete_after) VALUES(?,'opaque-subject','nid','private',?,'attached','2019-01-01','2019-01-02')").bind(id,key).run();
  const r=await mf.dispatchFetch(origin+'/test/cleanup',{method:'POST',body:JSON.stringify({now:'2020-01-01T00:00:00.000Z',accountDeleteRace:true})});assert.equal(r.status,200);assert.equal((await r.json()).deleted,1);
  assert.equal(await privateBucket.get(key),null);assert.equal(await db.prepare('SELECT id FROM verification_files WHERE id=?').bind(id).first(),null);
});

test('recommendations persist once per customer, remain separate from reviews and interest, and enforce access',async()=>{
  const owner=await account('recommendowner','seller'), first=await account('recommendfirst'), second=await account('recommendsecond');
  const sid='recommend-shop';
  await seedSeller(owner,sid,'verified');
  const payload={sellerId:sid,recommended:true};
  for(const cookie of ['',owner.cookie,admin.cookie]){
    assert.equal((await request('/api/buyer/recommendation',cookie,payload)).status,403);
    assert.equal((await request('/api/buyer/feedback/'+sid,cookie)).status,403);
  }
  assert.equal((await request('/api/buyer/recommendation',first.cookie,{...payload,userId:second.id})).status,400);
  assert.equal((await request('/api/buyer/recommendation',first.cookie,{...payload,recommended:'true'})).status,400);
  assert.equal((await request('/api/buyer/recommendation',first.cookie,payload,{Origin:'https://evil.test'})).status,403);
  const race=await Promise.all(Array.from({length:8},()=>request('/api/buyer/recommendation',first.cookie,payload)));
  assert.ok(race.every(response=>response.status===200));
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_recommendations WHERE seller_id=?').bind(sid).first()).n,1);
  assert.equal((await request('/api/buyer/recommendation',second.cookie,payload)).status,200);
  const details=async()=> (await (await request('/api/public/sellers/'+sid)).json()).seller;
  assert.equal((await details()).recommendation_count,2);
  assert.equal((await details()).interest_count,0);
  assert.equal((await details()).review_count,0);
  assert.equal((await request('/api/buyer/interest',first.cookie,{sellerId:sid})).status,200);
  assert.equal((await request('/api/buyer/review',first.cookie,{sellerId:sid,rating:5,body:'Delicious food, served fresh.'})).status,200);
  assert.equal((await request('/api/buyer/review/edit',first.cookie,{sellerId:sid,rating:4,body:'Fresh food and a friendly seller.'})).status,200);
  const feedback=await (await request('/api/buyer/feedback/'+sid,first.cookie)).json();
  assert.equal(feedback.recommended,true);assert.equal(feedback.review.rating,4);
  assert.equal((await (await request('/api/buyer/feedback/'+sid,second.cookie)).json()).review,null);
  const catalogue=await (await request('/api/public/catalogue')).json();
  const food=catalogue.foods.find(food=>food.seller_id===sid);
  assert.equal(food.recommendation_count,2);assert.equal(food.review_count,1);assert.equal(food.interest_count,1);
  const directory=await (await request('/api/public/sellers?search=recommend-shop')).json();
  assert.equal(directory.sellers[0].recommendation_count,2);
  assert.equal((await request('/api/buyer/recommendation',first.cookie,{sellerId:sid,recommended:false})).status,200);
  assert.equal((await details()).recommendation_count,1);
  assert.equal((await details()).interest_count,1);assert.equal((await details()).review_count,1);
  assert.equal((await (await request('/api/buyer/feedback/'+sid,first.cookie)).json()).recommended,false);
  assert.equal((await (await request('/api/buyer/feedback/'+sid,second.cookie)).json()).recommended,true);
  await db.prepare("UPDATE sellers SET status='pending' WHERE id=?").bind(sid).run();
  assert.equal((await request('/api/buyer/recommendation',first.cookie,payload)).status,404);
  assert.equal((await request('/api/buyer/feedback/'+sid,first.cookie)).status,404);
  await db.prepare("UPDATE sellers SET status='verified' WHERE id=?").bind(sid).run();
  await db.prepare("INSERT INTO seller_suspensions(seller_id,reason,created) VALUES(?,'Under review','2026-01-01')").bind(sid).run();
  assert.equal((await request('/api/buyer/recommendation',first.cookie,payload)).status,404);
  assert.equal((await request('/api/buyer/feedback/'+sid,first.cookie)).status,404);
  assert.equal((await request('/api/public/sellers/'+sid)).status,404);
  await db.prepare('DELETE FROM seller_suspensions WHERE seller_id=?').bind(sid).run();
  // A role change must not let an owner recommend their own shop.
  await db.prepare("UPDATE auth_users SET role='buyer' WHERE id=?").bind(owner.id).run();
  assert.equal((await request('/api/buyer/recommendation',owner.cookie,payload)).status,404);
  await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:second.id})});
  assert.equal((await details()).recommendation_count,0);
  assert.equal((await request('/api/buyer/recommendation',first.cookie,payload)).status,200);
  const deletedOwner=await mf.dispatchFetch(origin+'/test/delete-account',{method:'POST',body:JSON.stringify({userId:owner.id})});
  assert.equal(deletedOwner.status,200);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM seller_recommendations WHERE seller_id=?').bind(sid).first()).n,0);
});

test('named location search matches road, neighborhood, city and district without requiring coordinates',async()=>{
  const a=await account('locationgulshan','seller'), b=await account('locationother','seller'), c=await account('locationpending','seller');
  await seedSeller(a,'location-gulshan','verified');await seedSeller(b,'location-other','verified');await seedSeller(c,'location-pending','pending');
  await db.prepare("UPDATE sellers SET address='Road 12, Gulshan 1, Dhaka',name='Real kitchen' WHERE id='location-gulshan'").run();
  await db.prepare("UPDATE sellers SET address='Road 5, Agrabad, Chattogram',name='Gulshan 1 Dhaka' WHERE id='location-other'").run();
  await db.prepare("UPDATE sellers SET address='Road 12, Gulshan 1, Dhaka' WHERE id='location-pending'").run();
  const find=async location=>{
    const response=await request('/api/public/sellers?'+new URLSearchParams({location}));
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  const exact=await find('Road 12, Gulshan 1, Dhaka');
  assert.deepEqual(exact.sellers.map(s=>s.id),['location-gulshan']);assert.equal(exact.total,1);
  assert.equal(exact.sellers[0].distance_km,undefined);
  assert.deepEqual((await find('gulshan 1, dhaka')).sellers.map(s=>s.id),['location-gulshan']);
  assert.ok((await find('Chattogram')).sellers.some(s=>s.id==='location-other'));
  assert.equal((await find('Road 99, Gulshan 1, Dhaka')).total,0);
  assert.equal((await find("' OR 1=1 --")).total,0);
  assert.equal((await request('/api/public/sellers?location='+encodeURIComponent('x'.repeat(401)))).status,400);
  assert.equal((await request('/api/public/sellers?location='+encodeURIComponent(', ,'))).status,400);
  assert.equal((await request('/api/public/sellers?location=Dhaka&location=Gulshan')).status,400);
  await db.prepare("INSERT INTO seller_suspensions VALUES('location-gulshan','Under review','2026-01-01')").run();
  assert.equal((await find('Gulshan 1, Dhaka')).total,0);
});


test('admin account moderation requires MFA, protects admins, revokes buyers and hides sellers',async()=>{
  const target=await account('moderatedseller','seller');await seedSeller(target,'moderated-shop','verified');
  const decision={userId:target.id,action:'ban',reason:'Repeated violation of Foodlane rules'};
  assert.equal((await request('/api/admin/accounts',buyer.cookie)).status,403);
  assert.equal((await request('/api/admin/accounts/decision',buyer.cookie,decision)).status,403);
  const locked=await newAdmin('moderatorlocked');
  assert.equal((await request('/api/admin/accounts/decision',locked.cookie,decision)).status,403);
  assert.equal((await request('/api/admin/accounts/decision',admin.cookie,{...decision,userId:admin.id})).status,400);
  assert.equal((await request('/api/admin/accounts/decision',admin.cookie,{...decision,userId:locked.id})).status,404);
  assert.equal((await request('/api/admin/accounts/decision',admin.cookie,decision)).status,200);
  assert.equal((await request('/api/account/me',target.cookie)).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE user_id=?').bind(target.id).first()).n,0);
  assert.equal((await db.prepare('SELECT status FROM sellers WHERE id=?').bind('moderated-shop').first()).status,'suspended');
  const hidden=await (await request('/api/public/catalogue?search=moderated-shop')).json();assert.equal(hidden.total,0);
  const directory=await (await request('/api/admin/accounts?search=moderatedseller&status=banned',admin.cookie)).json();
  assert.equal(directory.accounts.length,1);assert.equal(directory.accounts[0].id,target.id);
  assert.equal((await request('/api/admin/accounts/decision',admin.cookie,{...decision,action:'unban'})).status,200);
  assert.equal((await db.prepare('SELECT status FROM sellers WHERE id=?').bind('moderated-shop').first()).status,'pending');
  assert.equal((await request('/api/account/me',target.cookie)).status,401);
  assert.equal((await request('/api/admin/accounts/decision',admin.cookie,{...decision,action:'delete',confirmation:'DELETE wrong'})).status,400);
  const deleted=await request('/api/admin/accounts/decision',admin.cookie,{...decision,action:'delete',confirmation:'DELETE '+target.id});
  assert.equal(deleted.status,200,await deleted.clone().text());assert.equal((await deleted.json()).dataDeleted,true);
  assert.equal(await db.prepare('SELECT id FROM auth_users WHERE id=?').bind(target.id).first(),null);
  const logs=await db.prepare('SELECT action,admin_ref FROM audit_log WHERE subject=? ORDER BY rowid').bind(target.id).all();
  assert.ok(logs.results.some(row=>row.action==='account_banned'&&row.admin_ref===admin.id));
  assert.equal((await request('/api/admin/cleanup',admin.cookie)).status,200);
});

test('catalogue searches and ranks all dishes before bounded pagination, and offers persist',async()=>{
  const target=await account('cataloguebulk','seller');await seedSeller(target,'catalogue-bulk','verified');
  const inserts=[];for(let i=0;i<205;i++)inserts.push(db.prepare('INSERT INTO foods VALUES(?,?,?,?,?,?,?,?)').bind('bulk-'+String(i).padStart(3,'0'),'catalogue-bulk',i===0?'Old hidden noodle':'Bulk dish '+i,'Fresh',100,'Noodles','',1));await db.batch(inserts);
  const old=await request('/api/public/catalogue?search=Old%20hidden%20noodle');assert.equal(old.status,200,await old.clone().text());assert.equal((await old.json()).foods[0].id,'bulk-000');
  const first=await (await request('/api/public/catalogue?search=Bulk&limit=20')).json();assert.equal(first.foods.length,20);assert.equal(first.hasMore,true);assert.ok(first.total>=205);
  const second=await (await request('/api/public/catalogue?search=Bulk&limit=20&page=2')).json();assert.equal(second.foods.length,20);assert.ok(!first.foods.some(a=>second.foods.some(b=>a.id===b.id)));
  const offer=await request('/api/seller/food',target.cookie,{id:'bulk-000',name:'Old hidden noodle',description:'Fresh noodles',price:80,category:'Noodles',image:'/api/seller/photos/11111111-1111-4111-8111-111111111111',available:true,originalPrice:100,offerLabel:'Lunch offer'});
  assert.equal(offer.status,200,await offer.clone().text());
  const offers=await request('/api/public/catalogue?collection=offers&search=Old');assert.equal(offers.status,200,await offers.clone().text());const discounted=(await offers.json()).foods[0];assert.equal(discounted.original_price,100);assert.equal(discounted.price,80);assert.equal(discounted.offer_label,'Lunch offer');
});


test('provider and database deletion failures keep a durable disabled account and recover on retry',async()=>{
  for(const fault of ['provider','database']){
    const target=await account('deletionfault'+fault);
    const response=await request('/test/provider-delete','',{userId:target.id,fail:fault==='provider',localFail:fault==='database'});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).deletionPending,true);
    const job=await db.prepare('SELECT provider_deleted,attempts,last_error FROM account_deletion_jobs WHERE user_id=?').bind(target.id).first();assert.equal(job.provider_deleted,fault==='provider'?0:1);assert.equal(job.attempts,1);assert.equal(job.last_error,'deletion-unavailable');
    assert.equal((await db.prepare('SELECT account_status FROM auth_users WHERE id=?').bind(target.id).first()).account_status,'deleting');assert.equal((await request('/api/account/me',target.cookie)).status,401);
    await db.prepare('UPDATE account_deletion_jobs SET next_attempt_at=0 WHERE user_id=?').bind(target.id).run();
    const retry=await request('/test/provider-delete','',{userId:target.id,retry:true});assert.equal((await retry.json()).completed,1);assert.equal(await db.prepare('SELECT id FROM auth_users WHERE id=?').bind(target.id).first(),null);assert.equal(await db.prepare('SELECT user_id FROM account_deletion_jobs WHERE user_id=?').bind(target.id).first(),null);
  }
});
