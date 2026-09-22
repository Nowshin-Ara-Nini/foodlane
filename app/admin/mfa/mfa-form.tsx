'use client';
import { useState } from 'react';
import Link from 'next/link';
import SignOut from '../../../components/sign-out';
export default function AdminMfa({enrolled}:{enrolled:boolean}){
  const [setup,setSetup]=useState<{secret:string;uri:string}|null>(null),[codes,setCodes]=useState<string[]>([]);
  const [recovery,setRecovery]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  async function send(action:string,data:Record<string,string>){
    setBusy(true);setError('');
    try{
      const response=await fetch(`/api/admin/mfa/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),cache:'no-store'});
      const result=await response.json() as {error?:string;secret?:string;uri?:string;recoveryCodes?:string[]};if(!response.ok)throw Error(result.error??'Could not verify.');
      if(action==='enroll'){if(!result.secret||!result.uri)throw Error('Setup unavailable.');setSetup({secret:result.secret,uri:result.uri});}
      else if(result.recoveryCodes){setSetup(null);setCodes(result.recoveryCodes);}
      else window.location.assign(new URL('/admin',window.location.origin).href);
    }catch(e){setError(e instanceof Error?e.message:'Could not verify.');}finally{setBusy(false)}
  }
  return <main className="mx-auto max-w-xl p-6"><Link className="brand" href="/">foodlane.</Link><section className="panel mt-6"><h1>Admin two-factor authentication</h1><p>Every admin session needs verification, including sessions signed in with Google.</p>{error&&<p className="notice" role="alert">{error}</p>}
    {codes.length>0?<><h2>Save your recovery codes</h2><p>Each code works once. Store them in your password manager. They will not be displayed again.</p><pre className="overflow-x-auto rounded border p-3" aria-label="Recovery codes">{codes.join('\n')}</pre><label><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)}/> I have saved my recovery codes.</label><button className="button primary mt-4" disabled={!saved} onClick={()=>window.location.assign(new URL('/admin',window.location.origin).href)}>Continue to admin</button></>:
      !enrolled&&!setup?<><p>Sign in within the last ten minutes, then add Foodlane to your authenticator app.</p><button className="button primary" disabled={busy} onClick={()=>send('enroll',{})}>Set up authenticator</button></>:
      <>{setup&&<><h2>Add an authenticator account</h2><p>Use this setup key with time-based codes, six digits, and a 30-second interval.</p><code className="block break-all rounded border p-3 select-all">{setup.secret}</code><p><a href={setup.uri}>Open in an authenticator app</a></p><p>Setup expires after ten minutes. Never share this key.</p></>}
      <form className="stack" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void send(setup?'confirm':recovery?'recover':'verify',{code:String(f.get('code')??'')});e.currentTarget.reset();}}>
        <label className="field">{recovery?'Recovery code':'Authenticator code'}<input key={recovery?'recovery':'totp'} name="code" required autoComplete="one-time-code" inputMode={recovery?'text':'numeric'} pattern={recovery?undefined:'[0-9]{6}'} minLength={recovery?32:6} maxLength={recovery?64:6}/></label>
        <button className="button primary" disabled={busy}>{busy?'Verifying…':setup?'Confirm enrollment':'Verify this session'}</button>
      </form>{enrolled&&<button className="button mt-3" disabled={busy} onClick={()=>{setRecovery(!recovery);setError('')}}>{recovery?'Use authenticator instead':'Use a recovery code'}</button>}</>}
    <div className="mt-6"><SignOut/></div>
  </section></main>;
}
