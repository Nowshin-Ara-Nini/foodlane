'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LocationMap, { type Point } from './location-map';
import type { PublicSeller } from '@/lib/discovery';

export default function ExploreSellers() {
  const [center,setCenter] = useState<Point>({lat:23.746,lng:90.373}), [radius,setRadius] = useState(5);
  const [query,setQuery] = useState(''), [revision,setRevision] = useState(0), [page,setPage] = useState(1), [sellers,setSellers] = useState<PublicSeller[]>([]);
  const [total,setTotal] = useState(0), [error,setError] = useState(''), [busy,setBusy] = useState(true), [notice,setNotice] = useState('');
  useEffect(()=>{
    const controller = new AbortController();
    fetch(`/api/public/sellers?${query}&page=${page}`,{signal:controller.signal}).then(async r=>{const d=await r.json() as {sellers:PublicSeller[];total:number;error?:string};if(!r.ok)throw Error(d.error);setSellers(d.sellers);setTotal(d.total);setError('');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[query,page,revision]);
  function search(point=center) {setRevision(n=>n+1);setBusy(true);setPage(1);setQuery(new URLSearchParams({lat:String(point.lat),lng:String(point.lng),radius:String(radius)}).toString());}
  return <><p className="intro">Find approved sellers near a location you choose. Click the map to set your search point.</p><form className="panel form-grid" onSubmit={e=>{e.preventDefault();search();}}>
    <label className="field">Latitude<input type="number" step="any" min="-90" max="90" required value={center.lat} onChange={e=>setCenter({...center,lat:Number(e.target.value)})}/></label>
    <label className="field">Longitude<input type="number" step="any" min="-180" max="180" required value={center.lng} onChange={e=>setCenter({...center,lng:Number(e.target.value)})}/></label>
    <label className="field">Radius (km)<input type="number" min="0.1" max="100" step="0.1" required value={radius} onChange={e=>setRadius(Number(e.target.value))}/></label>
    <div className="full" style={{display:'flex',gap:12,flexWrap:'wrap'}}><button className="button primary">Search this area</button><button type="button" className="button" onClick={()=>{
      if(!navigator.geolocation){setNotice('Choose your location on the map or enter coordinates.');return;}
      setNotice('Finding your location…');navigator.geolocation.getCurrentPosition(p=>{const point={lat:p.coords.latitude,lng:p.coords.longitude};setCenter(point);search(point);setNotice('Results sorted by distance from your location.');},()=>setNotice('Location unavailable or permission denied. Click the map or enter coordinates, then search this area.'),{timeout:15000,maximumAge:60000});
    }}>Near me</button><button type="button" className="button" onClick={()=>{setBusy(true);setPage(1);setQuery('');setRevision(n=>n+1);}}>All approved sellers</button></div>
  </form><p role="status">{notice}</p>{error&&<p role="alert">{error}</p>}<LocationMap center={center} pins={sellers} onPick={setCenter} height={450}/><p className="small">Green markers link to approved sellers on this results page. The draggable pin is your search location. Map tiles are provided by OpenStreetMap.</p>
  <h2>{busy?'Loading sellers…':`${total} approved sellers${query?' in this area':''}`}</h2><div className="cards">{sellers.map(s=><article className="panel" key={s.id}><h3><Link href={`/sellers/${encodeURIComponent(s.id)}`}>{s.name}</Link></h3><span className="badge">Verified</span><p>{s.place_label}</p><p>{s.bio}</p><p>{s.distance_km!==undefined&&`${s.distance_km.toFixed(2)} km · `}{s.review_count?`${Number(s.rating).toFixed(1)} / 5 (${s.review_count} reviews)`:'No reviews yet'}</p><Link className="button" href={`/sellers/${encodeURIComponent(s.id)}`}>View seller & food</Link></article>)}</div>
  {!busy&&!total&&<p>No approved sellers found. Try a different location or a wider radius.</p>}<div style={{display:'flex',gap:12}}><button className="button" disabled={busy||page===1} onClick={()=>{setBusy(true);setPage(page-1);}}>Previous</button><span>Page {page}</span><button className="button" disabled={busy||page*20>=total} onClick={()=>{setBusy(true);setPage(page+1);}}>Next</button></div></>;
}
