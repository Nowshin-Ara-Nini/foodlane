'use client';
/* eslint-disable @next/next/no-img-element -- Local object URLs power upload previews; private document requests bypass the image optimizer. */
import LocationMap from './location-map';
import ImageUpload from './image-upload';
import {useState} from 'react';
import {ClipboardCheck,Navigation} from 'lucide-react';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {toast} from 'sonner';
import {googleMapsSearchUrl} from '@/lib/location-search';
export default function VerificationForm({busy,save,seller}:{busy:boolean;save:(body:FormData,message:string)=>Promise<boolean>;seller:{lat:number;lng:number;place_label:string}}){
const [gender,setGender]=useState('');
const [uploadKey,setUploadKey]=useState(0);
const [lat,setLat]=useState(String(seller.lat??'')),[lng,setLng]=useState(String(seller.lng??''));
const [locating,setLocating]=useState(false);
function locate(){if(!navigator.geolocation){toast.error('Location is unavailable. Enter coordinates instead.');return}setLocating(true);navigator.geolocation.getCurrentPosition(p=>{setLat(String(p.coords.latitude));setLng(String(p.coords.longitude));setLocating(false);toast.success('Location filled. Check that it matches your selling place.')},()=>{setLocating(false);toast.error('Could not access location. Enter coordinates instead.')},{timeout:15000,maximumAge:0,enableHighAccuracy:true})}
return <form className="form-grid" onSubmit={async e=>{e.preventDefault();if(!gender){toast.error('Please select your gender.');return}const form=e.currentTarget;const fields=new FormData(form);if(Number(fields.get('age'))<18){toast.error('Seller applicants must be at least 18.');return}fields.set('gender',gender);if(await save(fields,'Verification details submitted for review')){form.reset();setGender('');setUploadKey(key=>key+1)}}}>
<div className="full verification-section"><h3>1. Personal details</h3><p>Use the name shown on your NID. These details are not displayed on your public seller profile.</p></div>
<label className="field">Full name<input name="legalName" required maxLength={120} autoComplete="name"/></label>
<label className="field">Age<input name="age" type="number" required min="18" max="120" step="1" placeholder="Age in years"/></label>
<label className="field">Gender<Select value={gender} onValueChange={setGender} required><SelectTrigger className="w-full" aria-label="Gender"><SelectValue placeholder="Select gender"/></SelectTrigger><SelectContent>{['Female','Male','Other','Prefer not to say'].map(g=><SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent></Select></label>
<label className="field">Personal email<input name="personalEmail" type="email" required maxLength={254} autoComplete="email"/></label>
<label className="field">Personal phone number<input name="personalPhone" type="tel" required maxLength={30} autoComplete="tel" placeholder="e.g. +880 1XXXXXXXXX"/></label>
<ImageUpload key={'passport-'+uploadKey} name="passport" label="Passport-size photo" help="A clear, recent head-and-shoulders photo. JPEG or PNG, up to 5 MB." required/>
<div className="full"><label className="field">Home address<textarea name="homeAddress" required maxLength={700} autoComplete="street-address" placeholder="House, road, area, city or district and postal code"/></label></div>
<div className="full verification-section"><h3>2. National identity document</h3><p>The reviewer will compare your NID details with your name and photo.</p></div>
<label className="field">NID number<input name="nidNumber" type="text" inputMode="numeric" required maxLength={30} autoComplete="off" placeholder="Enter the number shown on your NID"/><small>Enter digits only. Leading zeros are preserved.</small></label>
<ImageUpload key={'identity-'+uploadKey} name="identity" label="NID photo" help="A clear photo showing your name, face and NID number. JPEG or PNG, up to 5 MB." required/>
<div className="full verification-section"><h3>3. Your food-selling place</h3><p>Show your actual food cart, stall, shop or kitchen and tell us where it is located.</p></div>
<ImageUpload key={'selling-'+uploadKey} name="selling" label="Food cart or selling-place photo" help="Show your setup and food clearly, with a handwritten note showing today's date. Up to 5 MB." required/>
<label className="field">Selling-place address<input name="placeAddress" required maxLength={500} defaultValue={seller.place_label} placeholder="Street, nearby landmark and area"/></label>
<label className="field">Selling-place latitude<input name="placeLat" type="number" step="any" min="-90" max="90" required value={lat} onChange={e=>setLat(e.target.value)}/></label>
<label className="field">Selling-place longitude<input name="placeLng" type="number" step="any" min="-180" max="180" required value={lng} onChange={e=>setLng(e.target.value)}/></label>
<div className="full"><LocationMap center={{lat:Number(lat),lng:Number(lng)}} onPick={p=>{setLat(String(p.lat));setLng(String(p.lng));}}/><p className="small">Click the map or drag the pin to your selling place or a nearby pickup point.</p></div>
<div className="full"><button type="button" className="button" disabled={locating} onClick={locate}><Navigation/>{locating?'Finding location…':'Use my selling-place location'}</button><p className="small">Use this while you are at your cart or selling place, or enter its coordinates manually. This records the location for your verification submission.</p></div>
<div className="full"><label className="field">About your selling setup<textarea name="note" required maxLength={1000} placeholder="What do you sell, and how do you prepare and serve it?"/></label></div>
<div className="full notice"><p>After approval, your selling-place label, map pin, and selling-place photo will be public. If you cook at home, consider choosing a nearby pickup point instead of your home.</p></div>
<label className="full"><input type="checkbox" name="locationConsent" required/> I confirm that my selling-place label, pin, and photo will become public after approval.</label>
<label className="full"><input type="checkbox" name="portraitConsent"/> Display my passport-size photo on my public seller profile after approval.</label>
<p className="full small">Your NID photo stays private. Portrait sharing is optional and can be withdrawn at any time. Submitted verification documents cannot be viewed from your seller account.</p>
<div className="full"><button disabled={busy} className="button primary"><ClipboardCheck/>{busy?'Submitting…':'Submit for review'}</button></div>
</form>}
export function VerificationDetails({record:v}:{record:{id:string;legal_name?:string|null;age?:number|null;gender?:string|null;personal_email?:string|null;personal_phone?:string|null;nid_number?:string|null;home_address?:string|null;place_address?:string|null;place_lat?:number|null;place_lng?:number|null;has_passport?:boolean;has_identity?:boolean;has_selling?:boolean}|null}){if(!v)return null;const items=[['Full name',v.legal_name],['Age',v.age],['Gender',v.gender],['Personal email',v.personal_email],['Personal phone',v.personal_phone],['NID number',v.nid_number],['Home address',v.home_address],['Selling-place address',v.place_address]];return <><dl className="verification-details">{items.map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value??'Not provided in this earlier submission'}</dd></div>)}</dl>{v.place_lat!=null&&v.place_lng!=null&&<p><a className="button" target="_blank" rel="noreferrer" href={googleMapsSearchUrl(`${v.place_lat},${v.place_lng}`)}><Navigation/>View submitted selling location in Google Maps</a><span className="small"> {v.place_lat}, {v.place_lng}</span></p>}<div className="review-grid verification-photos">{([['Passport-size photo',v.has_passport?'passport':null],['NID photo',v.has_identity?'identity':null],['Food cart or selling place',v.has_selling?'selling':null]] as const).map(([label,key])=>key?<a key={label} href={'/api/admin/verifications/'+encodeURIComponent(v.id)+'/documents/'+key} target="_blank" rel="noreferrer"><img src={'/api/admin/verifications/'+encodeURIComponent(v.id)+'/documents/'+key} alt={label}/><span>{label} · Open photo</span></a>:<p key={label}>{label}: not provided in this earlier submission.</p>)}</div></>}
