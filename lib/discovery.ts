import { z } from 'zod';
import { HttpError } from './permissions';

const R = 6371.0088;
const rad = (degrees: number) => degrees * Math.PI / 180;
const deg = (radians: number) => radians * 180 / Math.PI;
const wrap = (longitude: number) => ((longitude + 540) % 360) - 180;
export function distanceKm(lat: number, lng: number, otherLat: number, otherLng: number) {
  const a = Math.sin(rad(otherLat - lat) / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(otherLat)) * Math.sin(rad(otherLng - lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}
export function bounds(lat: number, lng: number, radius: number) {
  const angle = radius / R;
  const south = Math.max(-90, lat - deg(angle)), north = Math.min(90, lat + deg(angle));
  if (south === -90 || north === 90) return { south, north, west: -180, east: 180 };
  const delta = deg(Math.asin(Math.min(1, Math.sin(angle) / Math.cos(rad(lat)))));
  return { south, north, west: wrap(lng - delta), east: wrap(lng + delta) };
}
export type PublicSeller = { id: string; name: string; bio: string; place_label: string; lat: number; lng: number; hours: string; status: string; rating: number | null; review_count: number; interest_count: number; place: string | null; portrait: string | null; distance_km?: number };
export const sellerProjection = `s.id,s.name,s.bio,s.address place_label,s.lat,s.lng,s.hours,s.status,
  (SELECT AVG(rating) FROM seller_reviews WHERE seller_id=s.id) rating,
  (SELECT COUNT(*) FROM seller_reviews WHERE seller_id=s.id) review_count,
  (SELECT COUNT(*) FROM seller_interests WHERE seller_id=s.id) interest_count,
  CASE WHEN EXISTS(SELECT 1 FROM verification_files vf JOIN seller_verifications v ON v.id=vf.submission_id WHERE v.seller_id=s.id AND v.status='verified' AND vf.kind='public-place' AND vf.state='attached' AND vf.delete_after IS NULL) THEN '/api/public/sellers/'||s.id||'/place' ELSE NULL END place,
  CASE WHEN EXISTS(SELECT 1 FROM verification_files vf JOIN seller_verifications v ON v.id=vf.submission_id WHERE v.seller_id=s.id AND v.status='verified' AND v.portrait_consent=1 AND v.portrait_withdrawn_at IS NULL AND vf.kind='portrait' AND vf.state='attached' AND vf.delete_after IS NULL) THEN '/api/public/sellers/'||s.id||'/portrait' ELSE NULL END portrait`;
const coordinate = (min: number, max: number) => z.string().trim().min(1).pipe(z.coerce.number<string>().finite().min(min).max(max));
const querySchema = z.object({ lat: coordinate(-90,90).optional(), lng: coordinate(-180,180).optional(), radius: coordinate(0.1,100).default(5), page: coordinate(1,10000).pipe(z.number().int()).default(1), limit: coordinate(1,100).pipe(z.number().int()).default(20) }).strict();
export async function discoverSellers(db: D1Database, url: URL) {
  if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new HttpError(400,'Duplicate search parameters.');
  const q = querySchema.parse(Object.fromEntries(url.searchParams));
  if ((q.lat === undefined) !== (q.lng === undefined)) throw new HttpError(400,'Both latitude and longitude are required.');
  const values: number[] = []; let filter = '';
  if (q.lat !== undefined && q.lng !== undefined) {
    const b = bounds(q.lat,q.lng,q.radius);
    filter = ` AND s.lat BETWEEN ? AND ? AND (s.lng >= ? ${b.west > b.east ? 'OR' : 'AND'} s.lng <= ?)`;
    values.push(b.south,b.north,b.west,b.east);
  }
  // Do not LIMIT the bounding-box candidates: exact radius filtering and sorting precede pagination.
  const result = await db.prepare(`SELECT ${sellerProjection} FROM sellers s WHERE s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)${filter}`).bind(...values).all<PublicSeller>();
  const nearby = q.lat !== undefined && q.lng !== undefined;
  const sellers = result.results.map(s => nearby ? { ...s, distance_km: distanceKm(q.lat!,q.lng!,s.lat,s.lng) } : s)
    .filter(s => !nearby || s.distance_km! <= q.radius)
    .sort((a,b) => nearby ? a.distance_km! - b.distance_km! || a.id.localeCompare(b.id) : a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { sellers: sellers.slice((q.page-1)*q.limit,q.page*q.limit), total: sellers.length, page: q.page, limit: q.limit, radius: nearby ? q.radius : null };
}
export async function sellerDetails(db: D1Database, id: string, url: URL) {
  const q = z.object({ page: coordinate(1,10000).pipe(z.number().int()).default(1) }).strict().parse(Object.fromEntries(url.searchParams));
  const seller = await db.prepare(`SELECT ${sellerProjection} FROM sellers s WHERE s.id=? AND s.status='verified' AND NOT EXISTS(SELECT 1 FROM seller_suspensions sx WHERE sx.seller_id=s.id)`).bind(id).first<PublicSeller>();
  if (!seller) throw new HttpError(404,'Seller unavailable.');
  const foods = await db.prepare("SELECT id,name,description,price,category,'/api/public/photos/'||id image FROM foods WHERE seller_id=? AND available=1 ORDER BY name,id LIMIT 200").bind(id).all();
  const reviews = await db.prepare('SELECT name,rating,body,created,updated FROM seller_reviews WHERE seller_id=? ORDER BY created DESC,user_id LIMIT 20 OFFSET ?').bind(id,(q.page-1)*20).all();
  return { seller, foods: foods.results, reviews: reviews.results, reviewPage: q.page };
}
