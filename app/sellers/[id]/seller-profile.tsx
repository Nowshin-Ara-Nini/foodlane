'use client';
/* eslint-disable @next/next/no-img-element -- Media must go directly through consent/status checks with no-store, without an image optimizer cache. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldCheck, Star, Heart } from 'lucide-react';
import LocationMap from '../../location-map';
import type { PublicSeller } from '@/lib/discovery';

type Review = { name?: string; rating: number; body: string; created: string; updated: string };
type Details = { seller: PublicSeller; foods: {id:string;name:string;description:string;price:number;image:string}[]; reviews: Review[] };
export default function SellerProfile({ id }: { id: string }) {
  const [data,setData] = useState<Details|null>(null), [error,setError] = useState(''), [message,setMessage] = useState('');
  const [role,setRole] = useState(''), [interested,setInterested] = useState(false), [own,setOwn] = useState<Review|null>(null);
  const [rating,setRating] = useState(5), [body,setBody] = useState(''), [editing,setEditing] = useState(false), [busy,setBusy] = useState(false), [page,setPage] = useState(1), [revision,setRevision] = useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    async function load() {
      const response=await fetch(`/api/public/sellers/${encodeURIComponent(id)}?page=${page}`,{signal:controller.signal});
      const details=await response.json() as Details & {error?:string};if(!response.ok)throw Error(details.error);setData(details);
      const me=await fetch('/api/account/me',{signal:controller.signal});
      if(!me.ok){setRole('');return;}
      const {user}=await me.json() as {user:{role:string;roleChosen:boolean}};setRole(user.roleChosen?user.role:'unchosen');
      if(user.role==='buyer'&&user.roleChosen){
        const [interest,review]=await Promise.all([fetch('/api/buyer/interests',{signal:controller.signal}),fetch(`/api/buyer/reviews/${encodeURIComponent(id)}`,{signal:controller.signal})]);
        if(!interest.ok||!review.ok)throw Error('Could not load your interest and review. Please refresh.');
        setInterested((await interest.json() as {interests:{seller_id:string}[]}).interests.some((i:{seller_id:string})=>i.seller_id===id));setOwn((await review.json() as {review:Review|null}).review);
      }
      setError('');
    }
    void load().catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();
  },[id,page,revision]);
  async function post(path:string,payload:object) {
    setBusy(true);setError('');setMessage('');
    try {const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json() as {error?:string};if(!r.ok)throw Error(d.error);setRevision(n=>n+1);return true;}
    catch(e){setError(e instanceof Error?e.message:'Please try again.');return false;}finally{setBusy(false);}
  }
  return <main className="shell"><Link className="brand" href="/">foodlane.</Link><p><Link href="/map">Explore nearby sellers</Link></p>{error&&<p role="alert" className="notice">{error}</p>}{message&&<p role="status">{message}</p>}{!data?<p>{error?'Seller unavailable.':'Loading seller…'}</p>:<>
    <div className="heading-row"><div><h1>{data.seller.name}</h1><span className="badge"><ShieldCheck size={16}/>Verified</span></div>{data.seller.portrait&&<img className="seller-portrait" src={data.seller.portrait} alt={`${data.seller.name} — shared with consent`}/>}</div>
    <p className="intro">{data.seller.bio}</p><p>{data.seller.place_label} · {data.seller.hours}</p><p><Star size={16}/>{data.seller.review_count?`${Number(data.seller.rating).toFixed(1)} / 5 · ${data.seller.review_count} reviews`:'No reviews yet'} · {data.seller.interest_count} people interested</p>
    {role==='buyer'?<button className="button primary" disabled={busy||interested} onClick={async()=>{if(await post('/api/buyer/interest',{sellerId:id})){setInterested(true);setMessage('Your interest is saved for this seller.');}}}><Heart size={16}/>{interested?'Interested':'I’m interested'}</button>:!role?<Link className="button" href={`/auth/login?returnTo=${encodeURIComponent('/sellers/'+id)}`}>Sign in as a buyer to show interest or review</Link>:<p>Only buyer accounts can show interest and leave reviews.</p>}
    <div className="panel"><h2>Where to find us</h2>{data.seller.place&&<img className="detail-image" src={data.seller.place} alt={`${data.seller.name} selling place`}/>}<LocationMap center={data.seller} pins={[data.seller]}/><p>{data.seller.place_label}</p><a className="button" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${data.seller.lat}&mlon=${data.seller.lng}#map=16/${data.seller.lat}/${data.seller.lng}`}>Open location in OpenStreetMap</a></div>
    <h2>Food available</h2><div className="cards">{data.foods.map(f=><article className="food-card" key={f.id}><img className="detail-image" src={f.image} alt={f.name}/><div className="card-body"><h3>{f.name}</h3><p>{f.description}</p><strong>৳{f.price}</strong></div></article>)}</div>{!data.foods.length&&<p>This seller has no available dishes yet.</p>}
    <div className="panel"><h2>Ratings & reviews</h2>{data.reviews.map((r,i)=><article className="review" key={`${r.created}-${i}`}><strong>{r.name}</strong><p>{r.rating} / 5 · {new Date(r.updated).toLocaleDateString()}</p><p>{r.body}</p></article>)}{!data.seller.review_count&&<p>No reviews yet.</p>}<div style={{display:'flex',gap:12}}><button className="button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous reviews</button><span>Page {page}</span><button className="button" disabled={page*20>=data.seller.review_count} onClick={()=>setPage(page+1)}>Next reviews</button></div></div>
    {role==='buyer'&&<form className="panel stack" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;if(await post('/api/buyer/report',{sellerId:id,reason:new FormData(form).get('reason')})){form.reset();setMessage('Your report was sent to the admin team.');}}}><h2>Report seller</h2><label className="field">What happened?<textarea name="reason" required minLength={10} maxLength={1000}/></label><p className="small">Reports are private to admins. Do not include NID numbers or other sensitive identity details.</p><button className="button" disabled={busy}>Report seller</button></form>}
    {role==='buyer'&&<div className="panel"><h2>{own?'Your review':'Share your experience'}</h2>{own&&!editing?<><p>{own.rating} / 5 · {own.body}</p><button className="button" onClick={()=>{setRating(own.rating);setBody(own.body);setEditing(true);}}>Edit review</button></>:<form className="stack" onSubmit={async e=>{e.preventDefault();if(await post(own?'/api/buyer/review/edit':'/api/buyer/review',{sellerId:id,rating,body})){setEditing(false);setMessage('Your review was saved.');}}}><label className="field">Rating<select value={rating} onChange={e=>setRating(Number(e.target.value))}>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n} / 5</option>)}</select></label><label className="field">Your review<textarea required maxLength={1000} value={body} onChange={e=>setBody(e.target.value)}/></label><p className="small">One review per buyer per seller. Your account display name is public with your review.</p><button className="button primary" disabled={busy}>{own?'Save changes':'Publish review'}</button>{editing&&<button type="button" className="button" onClick={()=>setEditing(false)}>Cancel</button>}</form>}</div>}
  </>}</main>;
}
