import {getUser} from '../../auth-session';
import {database,bucket,reviewer} from '../../../db/raw';
import {verificationFields,verificationImages} from '../../verification-validation';
function str(v:unknown,max=500){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Please complete all fields with valid values.');return v.trim()}
function num(v:unknown,min:number,max:number){const n=Number(v);if(v===''||v===null||!Number.isFinite(n)||n<min||n>max)throw Error('Please enter a valid number.');return n}
export async function POST(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});const user=await getUser();if(!user)return Response.json({error:'Please sign in to continue.'},{status:401});try{
const db=database(),type=req.headers.get('content-type')??'',now=new Date().toISOString();
if(type.includes('multipart/form-data')){
if(Number(req.headers.get('content-length')||0)>16*1024*1024)throw Error('Please keep each photo below 5 MB.');
const form=await req.formData();const seller=await db.prepare('SELECT * FROM sellers WHERE owner=?').bind(user.userId).first();
if(!seller)throw Error('Save your seller profile first.');if(seller.status==='pending')throw Error('Your evidence is already awaiting review.');if(seller.status==='verified')throw Error('Your seller profile is already verified.');
const v=verificationFields(form),images=await verificationImages(form),id=crypto.randomUUID(),prefix=`evidence/${seller.id}/${id}`,uploaded:string[]=[];
try{
for(const image of images){const key=`${prefix}/${image.name}`;await bucket().put(key,image.bytes,{httpMetadata:{contentType:image.contentType}});uploaded.push(key)}
await db.batch([
db.prepare('INSERT INTO verifications (id,seller_id,identity_key,selling_key,legal_name,note,status,created,age,gender,passport_key,personal_email,personal_phone,nid_number,home_address,place_address,place_lat,place_lng) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,seller.id,`${prefix}/identity`,`${prefix}/selling`,v.legalName,v.note,'pending',now,v.age,v.gender,`${prefix}/passport`,v.personalEmail,v.personalPhone,v.nidNumber,v.homeAddress,v.placeAddress,v.placeLat,v.placeLng),
db.prepare('UPDATE sellers SET status=? WHERE id=?').bind('pending',seller.id),
db.prepare('INSERT INTO verification_logs VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),seller.id,'Verification details submitted','Personal details, passport-size photo, NID and selling-place evidence received. Awaiting manual review.',now)
]);
}catch{await Promise.allSettled(uploaded.map(key=>bucket().delete(key)));throw Error('Could not save your verification submission. Please try again.');}
return Response.json({ok:true});}
const b=await req.json() as Record<string,any>;if(!b||typeof b!=="object")throw Error("Invalid request.");const seller=await db.prepare('SELECT * FROM sellers WHERE owner=?').bind(user.userId).first();
if(b.action==='profile'){const name=str(b.name,100),phone=str(b.phone,40),bio=str(b.bio,700),address=str(b.address,250),hours=str(b.hours,150),lat=num(b.lat,-90,90),lng=num(b.lng,-180,180);if(seller){if(name!==seller.name && seller.status==='pending')throw Error('Wait for the current review before changing your business name.');await db.prepare('UPDATE sellers SET name=?,phone=?,bio=?,address=?,lat=?,lng=?,hours=?,updated=?,status=? WHERE id=?').bind(name,phone,bio,address,lat,lng,hours,now,name!==seller.name?'unverified':seller.status,seller.id).run();if(name!==seller.name)await db.prepare('INSERT INTO verification_logs VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),seller.id,'Business name updated','Submit fresh evidence to verify the new business name.',now).run()}else{await db.prepare('INSERT INTO sellers VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user.userId,name,phone,bio,address,lat,lng,hours,'unverified',now).run()}}
else if(b.action==='food'){if(!seller)throw Error('Save your seller profile first.');if(seller.status!=='verified')return Response.json({error:'Your seller verification must be approved before you can publish food.'},{status:403});const name=str(b.name,120),description=str(b.description,700),category=str(b.category,50),price=num(b.price,1,100000),image=str(b.image,250);if(!image.startsWith('food/'+seller.id+'/'))throw Error('Upload your own food photo first.');if(b.id){const found=await db.prepare('SELECT id FROM foods WHERE id=? AND seller_id=?').bind(b.id,seller.id).first();if(!found)throw Error('Listing not found.');await db.prepare('UPDATE foods SET name=?,description=?,price=?,category=?,image=?,available=? WHERE id=?').bind(name,description,price,category,image,b.available?1:0,b.id).run()}else await db.prepare('INSERT INTO foods VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),seller.id,name,description,price,category,image,b.available?1:0).run()}
else if(b.action==='interest'||b.action==='review'){const food=await db.prepare("SELECT f.*,s.owner FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.id=? AND f.available=1 AND s.status='verified'").bind(str(b.foodId,100)).first();if(!food)throw Error('This listing is no longer available.');if(food.owner===user.userId)throw Error('You cannot rate or mark interest in your own listing.');if(b.action==='interest'){if(typeof b.interested!=='boolean')throw Error('Invalid interest value.');await db.prepare(b.interested?'INSERT OR IGNORE INTO interests VALUES(?,?)':'DELETE FROM interests WHERE food_id=? AND user_id=?').bind(b.foodId,user.userId).run()}else{const rating=num(b.rating,1,5);if(!Number.isInteger(rating))throw Error('Choose a whole star rating.');await db.prepare('INSERT INTO reviews VALUES(?,?,?,?,?,?) ON CONFLICT(food_id,user_id) DO UPDATE SET name=excluded.name,rating=excluded.rating,body=excluded.body,created=excluded.created').bind(b.foodId,user.userId,str(b.name,70),rating,str(b.body,1000),now).run()}}
else if(b.action==='decision'){
if(!reviewer(user.email))return Response.json({error:'Reviewer access required.'},{status:403});
if(!['verified','rejected'].includes(b.status))throw Error('Choose a valid decision.');
const note=str(b.note,1000),id=str(b.id,100),decisionId=crypto.randomUUID();
const result=await db.batch([
db.prepare("UPDATE verifications SET status=?,reviewed_by=?,reviewed_at=?,decision_note=?,decision_id=? WHERE id=? AND status='pending'").bind(b.status,user.email,now,note,decisionId,id),
db.prepare('UPDATE sellers SET status=? WHERE id=(SELECT seller_id FROM verifications WHERE id=? AND decision_id=?)').bind(b.status,id,decisionId),
db.prepare('INSERT INTO verification_logs (id,seller_id,action,note,created) SELECT ?,seller_id,?,?,? FROM verifications WHERE id=? AND decision_id=?').bind(crypto.randomUUID(),b.status==='verified'?'Approved — selling enabled':'Changes requested — selling locked',note,now,id,decisionId)
]);
if(!result[0].meta.changes)return Response.json({error:'This submission has already been reviewed. Refresh the review desk.'},{status:409});
}
else throw Error('Unknown action.');return Response.json({ok:true});
}catch(e){console.error('Foodlane action failed');return Response.json({error:e instanceof Error&&!e.message.includes('D1_')?e.message:'Could not save. Please try again.'},{status:400})}}
