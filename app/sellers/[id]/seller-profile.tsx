'use client';
/* eslint-disable @next/next/no-img-element -- Media must go directly through consent/status checks with no-store, without an image optimizer cache. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, Star, Heart } from 'lucide-react';
import LocationMap from '../../location-map';
import SellerFeedback from '../../seller-feedback';
import type { PublicSeller } from '@/lib/discovery';
import { googleMapsDirectionsUrl } from '@/lib/location-search';

type Details = { seller: PublicSeller; foods: {id:string;name:string;description:string;price:number;image:string;interest_count:number;rating:number|null;review_count:number}[] };
export default function SellerProfile({ id }: { id: string }) {
  const [data,setData] = useState<Details|null>(null), [error,setError] = useState(''), [message,setMessage] = useState('');
  const [role,setRole] = useState(''), [interestedFoods,setInterestedFoods] = useState<Set<string>>(()=>new Set());
  const [reviewFoodId,setReviewFoodId] = useState<string|null>(null);
  const [busy,setBusy] = useState(false), [revision,setRevision] = useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    async function load() {
      const response=await fetch(`/api/public/sellers/${encodeURIComponent(id)}?page=1`,{signal:controller.signal});
      const details=await response.json() as Details & {error?:string};if(!response.ok)throw Error(details.error);setData(details);
      const me=await fetch('/api/account/me',{signal:controller.signal});
      if(!me.ok){setRole('');return;}
      const {user}=await me.json() as {user:{role:string;roleChosen:boolean}};setRole(user.roleChosen?user.role:'unchosen');
      if(user.role==='buyer'&&user.roleChosen){
        const interest=await fetch('/api/buyer/interests',{signal:controller.signal});
        if(!interest.ok)throw Error('Could not load your interest. Please refresh.');
        setInterestedFoods(new Set((await interest.json() as {interests:{food_id:string}[]}).interests.map((i:{food_id:string})=>i.food_id)));
      }
      setError('');
    }
    void load().catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();
  },[id,revision]);
  async function post(path:string,payload:object) {
    setBusy(true);setError('');setMessage('');
    try {const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json() as {error?:string};if(!r.ok)throw Error(d.error);setRevision(n=>n+1);return true;}
    catch(e){setError(e instanceof Error?e.message:'Please try again.');return false;}finally{setBusy(false);}
  }
  return <main className="shell"><Link className="brand" href="/">foodlane.</Link><p><Link href="/map">Explore nearby sellers</Link></p>{error&&<p role="alert" className="notice">{error}</p>}{message&&<p role="status">{message}</p>}{!data?<p>{error?'Seller unavailable.':'Loading seller…'}</p>:<>
    <div className="heading-row"><div><h1>{data.seller.name}</h1><span className="badge"><ShieldCheck size={16}/>Verified</span></div>{data.seller.portrait&&<img className="seller-portrait" src={data.seller.portrait} alt={`${data.seller.name} — shared with consent`}/>}</div>
    <p className="intro">{data.seller.bio}</p><p>{data.seller.place_label} · {data.seller.hours}</p><p><Star size={16}/>{data.seller.review_count?`${Number(data.seller.rating).toFixed(1)} / 5 · ${data.seller.review_count} dish reviews`:'No dish reviews yet'} · {data.seller.interest_count} people interested in this seller’s food · {data.seller.recommendation_count} recommendations</p>
    <div className="panel"><h2>Where to find us</h2>{data.seller.place&&<img className="detail-image" src={data.seller.place} alt={`${data.seller.name} selling place`}/>}<LocationMap center={data.seller} pins={[data.seller]}/><p>{data.seller.place_label}</p><a className="button" target="_blank" rel="noreferrer" href={googleMapsDirectionsUrl(data.seller.lat,data.seller.lng)}>Directions in Google Maps</a></div>
    <h2>Food available</h2><div className="cards">{data.foods.map(f=>{const isInterested=interestedFoods.has(f.id);return <article className="food-card" key={f.id}><img className="detail-image" src={f.image} alt={f.name}/><div className="card-body"><h3>{f.name}</h3><p>{f.description}</p><strong>৳{f.price}</strong><p>{f.interest_count} interested in this dish</p><p><Star size={15}/>{f.review_count?`${Number(f.rating).toFixed(1)} · ${f.review_count} reviews`:'No reviews yet'}</p>{role==='buyer'?<button type="button" className={'button '+(isInterested?'liked':'primary')} disabled={busy} aria-pressed={isInterested} onClick={async()=>{if(await post('/api/buyer/interest',{foodId:f.id,interested:!isInterested}))setMessage(isInterested?'Your interest was removed from this dish.':'Your interest is saved for this dish.');}}><Heart size={16}/>{isInterested?'Interested':'I’m interested'}</button>:!role?<Link className="button" href={`/auth/login?returnTo=${encodeURIComponent('/sellers/'+id)}`}>Sign in to show interest in this dish</Link>:<p>Only buyer accounts can show interest in a dish.</p>}<button type="button" className="button" onClick={()=>setReviewFoodId(current=>current===f.id?null:f.id)}>{reviewFoodId===f.id?'Close dish reviews':'Reviews & leave a review'}</button>{reviewFoodId===f.id&&<SellerFeedback key={f.id} sellerId={id} foodId={f.id} role={role} showRecommendations={false} returnTo={'/sellers/'+id} onChange={()=>setRevision(value=>value+1)}/>}</div></article>})}</div>{!data.foods.length&&<p>This seller has no available dishes yet.</p>}
    <SellerFeedback sellerId={id} role={role} showReviews={false} onChange={()=>setRevision(value=>value+1)}/>
    {role==='buyer'&&<form className="panel stack" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;if(await post('/api/buyer/report',{sellerId:id,reason:new FormData(form).get('reason')})){form.reset();setMessage('Your report was sent to the admin team.');}}}><h2>Report seller</h2><label className="field">What happened?<textarea name="reason" required minLength={10} maxLength={1000}/></label><p className="small">Reports are private to admins. Do not include NID numbers or other sensitive identity details.</p><button className="button" disabled={busy}>Report seller</button></form>}
  </>}</main>;
}
