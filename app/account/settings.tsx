'use client';
import { useState } from 'react';
import Link from 'next/link';
import ImageUpload from '../image-upload';
import { privacyContact } from '@/lib/site-config';
/* eslint-disable @next/next/no-img-element -- Profile photo is served by the authenticated account endpoint. */
type Props={name:string;phone:string;email:string;image:string|null};
export default function AccountSettings({name:initialName,phone:initialPhone,email,image:initialImage}:Props){
  const [name,setName]=useState(initialName),[phone,setPhone]=useState(initialPhone),[avatar,setAvatar]=useState(initialImage),[avatarVersion,setAvatarVersion]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[done,setDone]=useState(false);
  async function readResult(r:Response){const result=await r.json() as {error?:string;message?:string;filesPending?:number|null;deletionPending?:boolean;cleanupPending?:boolean};if(!r.ok)throw Error(result.error??'Request failed.');return result;}
  return <main className="shell"><Link className="brand" href="/">foodlane.</Link><h1>Account & privacy</h1><p><span>{email}</span> · <Link href="/privacy">Read our privacy policy</Link></p>{error&&<p className="notice" role="alert">{error}</p>}{message&&<p className="notice" role="status">{message}</p>}{done?<Link href="/">Return to Foodlane</Link>:<>
    <section className="panel stack"><h2>Edit your profile</h2><p>Update the name and mobile number shown on your Foodlane account. Your profile photo is private unless you choose to share it elsewhere.</p>
      {avatar&&<div className="profile-photo-current"><img src={avatar.startsWith('/api/')?avatar.split('?')[0]+'?v='+avatarVersion:avatar} alt="Current profile photo" width="96" height="96" referrerPolicy="no-referrer"/><span>Current profile photo</span></div>}
      <form className="stack" onSubmit={async e=>{e.preventDefault();const data=new FormData(e.currentTarget);data.set('name',name);data.set('phone',phone);data.set('removePhoto',String(data.get('removePhoto')==='on'));setBusy(true);setError('');setMessage('');try{const result=await readResult(await fetch('/api/account/profile',{method:'POST',body:data}));setAvatar(data.get('removePhoto')==='true'?null:data.get('profilePhoto') instanceof File&&(data.get('profilePhoto') as File).size?'/api/account/profile-photo':avatar);setAvatarVersion(v=>v+1);setMessage(result.message??'Your profile has been updated.');}catch(cause){setError(cause instanceof Error?cause.message:'Please try again.');}finally{setBusy(false);}}}>
        <label className="field">Name<input value={name} onChange={e=>setName(e.target.value)} required maxLength={100} autoComplete="name"/></label>
        <label className="field">Mobile number<input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} required maxLength={32} autoComplete="tel"/></label>
        <ImageUpload name="profilePhoto" label="Change profile photo" help="Choose a new JPEG or PNG image, up to 5 MB."/>
        {avatar&&<label className="field flex-row"><input type="checkbox" name="removePhoto"/> Remove my current profile photo</label>}
        <button className="button primary" disabled={busy}>{busy?'Saving…':'Save profile'}</button>
      </form>
    </section>
    <section className="panel stack"><h2>Delete your account</h2><p>This permanently removes your account, seller profile, reviews, interests, reports and private verification details. Your app sessions are revoked immediately. Stored verification and food files are queued for deletion; if any file cleanup is pending, we’ll show that status. Minimal audit records remain.</p>
      <form className="stack" onSubmit={async e=>{e.preventDefault();const values=new FormData(e.currentTarget);setBusy(true);setError('');setMessage('');try{const result=await readResult(await fetch('/api/account/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmation:values.get('confirmation'),reason:values.get('reason')||undefined})}));setDone(true);setMessage(result.deletionPending?'Your account access has been disabled. Permanent deletion is queued and will be retried automatically.':result.cleanupPending?'Your account was deleted. Stored-file cleanup is queued and will be retried.':result.filesPending?('Your account was deleted. '+result.filesPending+' file deletion job(s) are still pending and will be retried.'):'Your account and stored files have been deleted.');}catch(cause){setError(cause instanceof Error?cause.message:'Please try again.');}finally{setBusy(false);}}}>
        <label className="field">Why are you deleting your account? (optional)<select name="reason" defaultValue=""><option value="">Prefer not to say</option><option value="not-using">I no longer use Foodlane</option><option value="privacy">Privacy concerns</option><option value="too-difficult">Foodlane was difficult to use</option><option value="technical-issues">Technical problems</option><option value="switching">I’m switching to another service</option><option value="other">Other</option></select></label>
        <p className="small">Your answer is stored without your name, email, or account ID and is used to improve Foodlane.</p>
        <label className="field">Type DELETE to confirm permanent account deletion<input name="confirmation" required pattern="DELETE" autoComplete="off"/></label>
        <button className="button danger" disabled={busy}>{busy?'Deleting…':'Permanently delete my account'}</button>
      </form>
    </section>
  </>}<p>For privacy or deletion help: <a href={'mailto:'+privacyContact}>{privacyContact}</a>. Do not email identity documents or passwords.</p></main>;
}
