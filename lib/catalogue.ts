import {z} from 'zod';
import {HttpError} from './permissions';
const selection=(max:number)=>z.string().max(3000).optional().transform(value=>{try{return value?JSON.parse(value):[]}catch{throw new HttpError(400,'Invalid filters.')}}).pipe(z.array(z.string().min(1).max(max)).max(10));
export async function catalogue(db:D1Database,url:URL) {
  const q=z.object({search:z.string().trim().max(80).default(''),cuisines:selection(50),places:selection(250),collection:z.enum(['all','reviewed','interested','burgers-pizza','trending-sellers','best-deals','offers']).default('all'),page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(200).default(48)}).strict().parse(Object.fromEntries(url.searchParams));
  let where="f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active')";
  const values:(string|number)[]=[];
  if(q.search){where+=" AND (instr(lower(f.name||' '||f.category||' '||s.name||' '||s.address||' '||f.description||' '||s.bio),lower(?))>0)";values.push(q.search);}
  for(const [column,items] of [['f.category',q.cuisines],['s.address',q.places]] as const){if(items.length){where+=' AND '+column+' IN ('+items.map(()=>'?').join(',')+')';values.push(...items);}}
  if(q.collection==='reviewed')where+=' AND EXISTS(SELECT 1 FROM seller_recommendations WHERE seller_id=s.id)';
  if(q.collection==='interested')where+=' AND EXISTS(SELECT 1 FROM seller_interests WHERE seller_id=s.id)';
  if(q.collection==='trending-sellers')where+=' AND (EXISTS(SELECT 1 FROM seller_interests WHERE seller_id=s.id) OR EXISTS(SELECT 1 FROM seller_reviews WHERE seller_id=s.id))';
  if(q.collection==='burgers-pizza')where+=" AND (instr(lower(f.name||' '||f.category),'burger')>0 OR instr(lower(f.name||' '||f.category),'pizza')>0)";
  if(q.collection==='offers')where+=' AND EXISTS(SELECT 1 FROM food_offers WHERE food_id=f.id AND original_price>f.price)';
  const order=q.collection==='reviewed'?'recommendation_count DESC,review_count DESC':q.collection==='interested'?'interest_count DESC,review_count DESC':q.collection==='trending-sellers'?'(interest_count*2+review_count) DESC':q.collection==='best-deals'?'f.price':q.collection==='burgers-pizza'?'rating DESC,review_count DESC':'f.rowid DESC';
  const [foods,total,facets,reviews]=await Promise.all([
    db.prepare(`SELECT f.id,f.seller_id,f.name,f.description,f.price,f.category,f.available,'/api/public/photos/'||f.id image,s.name seller_name,s.bio,s.address place_label,s.lat,s.lng,s.hours,s.status,s.updated,
      (SELECT COUNT(*) FROM seller_interests WHERE seller_id=s.id) interest_count,
      (SELECT COUNT(*) FROM seller_recommendations WHERE seller_id=s.id) recommendation_count,
      (SELECT AVG(rating) FROM seller_reviews WHERE seller_id=s.id) rating,
      (SELECT COUNT(*) FROM seller_reviews WHERE seller_id=s.id) review_count,
      (SELECT original_price FROM food_offers WHERE food_id=f.id) original_price,
      (SELECT label FROM food_offers WHERE food_id=f.id) offer_label
      FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE ${where} ORDER BY ${order},f.id LIMIT ? OFFSET ?`).bind(...values,q.limit,(q.page-1)*q.limit).all(),
    db.prepare(`SELECT COUNT(*) total FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE ${where}`).bind(...values).first<{total:number}>(),
    db.prepare("SELECT DISTINCT f.category,s.address place_label FROM foods f JOIN sellers s ON s.id=f.seller_id WHERE f.available=1 AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) AND EXISTS(SELECT 1 FROM auth_users WHERE id=s.owner AND account_status='active') ORDER BY f.category,s.address").all<{category:string;place_label:string}>(),
    db.prepare("SELECT r.seller_id,r.name,r.rating,r.body,r.created FROM seller_reviews r JOIN sellers s ON s.id=r.seller_id WHERE s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions WHERE seller_id=s.id) ORDER BY r.created DESC LIMIT 500").all(),
  ]);
  return {foods:foods.results,reviews:reviews.results,total:total?.total??0,page:q.page,limit:q.limit,hasMore:q.page*q.limit<(total?.total??0),facets:{cuisines:[...new Set(facets.results.map(f=>f.category))],places:[...new Set(facets.results.map(f=>f.place_label))]}};
}
