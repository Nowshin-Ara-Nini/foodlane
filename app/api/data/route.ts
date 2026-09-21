import {getUser} from '../../auth-session';
import {database,reviewer} from '../../../db/raw';
export async function GET(){try{const db=database(),user=await getUser();
const foods=await db.prepare(`SELECT f.*,s.name seller_name,s.bio,s.address,s.lat,s.lng,s.hours,s.status,s.phone,s.updated,(SELECT COUNT(*) FROM interests i WHERE i.food_id=f.id) interest_count,(SELECT AVG(rating) FROM reviews r WHERE r.food_id=f.id) rating,(SELECT COUNT(*) FROM reviews r WHERE r.food_id=f.id) review_count,(SELECT COUNT(*) FROM interests i WHERE i.food_id=f.id AND i.user_id=?) interested FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.available=1 AND s.status='verified' ORDER BY f.rowid DESC`).bind(user?.userId??'').all();
const seller=user?await db.prepare('SELECT * FROM sellers WHERE owner=?').bind(user.userId).first():null;
const ownFoods=seller?await db.prepare('SELECT f.*,(SELECT COUNT(*) FROM interests i WHERE i.food_id=f.id) interest_count FROM foods f WHERE seller_id=?').bind(seller.id).all():{results:[]};
const logs=seller?await db.prepare('SELECT action,note,created FROM verification_logs WHERE seller_id=? ORDER BY created DESC').bind(seller.id).all():{results:[]};
const submission=seller?await db.prepare('SELECT * FROM verifications WHERE seller_id=? ORDER BY created DESC LIMIT 1').bind(seller.id).first():null;
const reviews=await db.prepare("SELECT r.food_id,r.name,r.rating,r.body,r.created FROM reviews r JOIN foods f ON f.id=r.food_id JOIN sellers s ON s.id=f.seller_id WHERE f.available=1 AND s.status='verified' ORDER BY r.created DESC LIMIT 500").all();
const isReviewer=user?reviewer(user.email):false;
const queue=isReviewer?await db.prepare(`SELECT v.*,s.name seller_name FROM verifications v JOIN sellers s ON s.id=v.seller_id WHERE v.status='pending' ORDER BY v.created`).all():{results:[]};
const reviewHistory=isReviewer?await db.prepare("SELECT v.id,v.status,v.reviewed_by,v.reviewed_at,v.decision_note,s.name seller_name FROM verifications v JOIN sellers s ON s.id=v.seller_id WHERE v.status!='pending' ORDER BY v.reviewed_at DESC LIMIT 100").all():{results:[]};
return Response.json({reviewHistory:reviewHistory.results,foods:foods.results,seller,submission,ownFoods:ownFoods.results,logs:logs.results,reviews:reviews.results,user:user?{name:user.fullName||'Food lover',isReviewer}:null,queue:queue.results},{headers:{'Cache-Control':'private, no-store'}});
}catch(e){console.error(e);return Response.json({error:'Foodlane could not load right now. Please try again.'},{status:503});}}
