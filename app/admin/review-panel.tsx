'use client';
import { useEffect,useState,useCallback } from 'react';
import Link from 'next/link';
import { ShieldCheck,ClipboardCheck,RefreshCw } from 'lucide-react';
import AccountsPanel from './accounts-panel';
import ModerationPanel from './moderation-panel';
import SignOut from '../../components/sign-out';
import { VerificationDetails } from '../verification-form';
type Applicant={id:string;seller_name:string;created:string;note:string;portrait_consent:number;[key:string]:unknown};
type Decision={id:string;seller_name:string;status:string;reviewed_at:string;decision_note:string};
type Event={id:string;subject:string;action:string;admin_ref:string|null;created_at:string};
export default function AdminReview(){
  const [queue,setQueue]=useState<Applicant[]>([]),[history,setHistory]=useState<Decision[]>([]),[events,setEvents]=useState<Event[]>([]);
  const [cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [selected,setSelected]=useState<string|null>(null);
  const read=useCallback(async<T,>(path:string,body?:unknown):Promise<T>=>{
    const response=await fetch(path,{cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    if(response.status===403){window.location.assign(new URL('/admin/mfa',window.location.origin).href);throw Error('Admin verification required.');}
    const data=await response.json() as T & {error?:string};if(!response.ok)throw Error(data.error??'Request failed.');return data;
  },[]);
  const refresh=useCallback(async()=>{
    try{const data=await read<{queue:Applicant[];reviewHistory:Decision[]}>('/api/admin/verifications');setError('');setQueue(data.queue);setHistory(data.reviewHistory);const audit=await read<{events:Event[];nextCursor:string|null}>('/api/admin/audit');setEvents(audit.events);setCursor(audit.nextCursor);}
    catch(e){setError(e instanceof Error?e.message:'Unable to load review desk.');}finally{setLoading(false)}
  },[read]);
  useEffect(()=>{const task=setTimeout(()=>void refresh(),0);return()=>clearTimeout(task)},[refresh]);
  const record=queue.find(v=>v.id===selected);
  async function decide(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();if(!record)return;setBusy(true);setError('');
    const form=new FormData(event.currentTarget),status=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    try{await read('/api/admin/decision',{id:record.id,status,note:form.get('note'),eligibility:form.get('eligibility')});setSelected(null);await refresh();}
    catch(e){setError(e instanceof Error?e.message:'Unable to save decision.');}finally{setBusy(false)}
  }
  return <><header><div className="topbar"><Link className="brand" href="/">foodlane.</Link><Link href="/admin">Admin review</Link><SignOut/></div></header><main className="mx-auto max-w-6xl p-6">
    <div className="heading-row"><div><div className="eyebrow"><ShieldCheck/> SELLER TRUST</div><h1>Verification review desk</h1><p>Review identity and business evidence before approving a seller.</p></div><button className="button" disabled={busy||loading} onClick={()=>{setLoading(true);void refresh()}}><RefreshCw/> Refresh</button></div>
    {error&&<p className="notice" role="alert">{error}</p>}{loading&&<p role="status">Loading review desk…</p>}
    <section className="panel"><h2>Pending applicants ({queue.length})</h2>{!loading&&!queue.length&&<p>No submissions awaiting review.</p>}{queue.map(v=><div className="list-row" key={v.id}><div><strong>{v.seller_name}</strong><p>Submitted {new Date(v.created).toLocaleString()}</p></div><button className="button" onClick={()=>setSelected(selected===v.id?null:v.id)}>{selected===v.id?'Close details':'Review applicant'}</button></div>)}</section>
    {record&&<section className="panel" key={record.id}><h2>{record.seller_name}</h2><VerificationDetails record={record}/><p>{record.note}</p><p>Public portrait: {record.portrait_consent?'Consented':'Not consented (does not affect eligibility)'}</p><p>Check the applicant’s NID and passport photo, confirm age, and compare the selling place with the submitted location. Verification is not a food-safety certification.</p>
      <form className="stack" onSubmit={decide}><label className="field">Age eligibility<select name="eligibility" required defaultValue="unconfirmed"><option value="unconfirmed">Not confirmed</option><option value="adult">Evidence confirms age 18 or older</option><option value="underage">Evidence shows applicant is under 18</option></select></label><label className="field">Decision reason<textarea name="note" required maxLength={1000}/><small>The seller will see this reason. Do not include NID, contact details or other private values.</small></label><div className="flex gap-3"><button className="button primary" disabled={busy} value="verified">Approve seller</button><button className="button" disabled={busy} value="rejected">Reject with reason</button></div></form></section>}
    <section className="panel"><h2>Recent decisions</h2>{history.length?history.map(v=><div className="log-entry" key={v.id}><ClipboardCheck/><div><strong>{v.seller_name} · {v.status==='verified'?'Approved':'Rejected'}</strong><p>{v.decision_note}</p><time>{new Date(v.reviewed_at).toLocaleString()}</time></div></div>):<p>No decisions yet.</p>}</section>
    <AccountsPanel onChange={()=>void refresh()}/><ModerationPanel onChange={()=>void refresh()}/><section className="panel"><h2>Audit history</h2><p>Opaque references identify subjects and administrators without retaining private details.</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Time</th><th>Action</th><th>Subject reference</th><th>Admin reference</th></tr></thead><tbody>{events.map(e=><tr key={e.id}><td className="p-2">{new Date(e.created_at).toLocaleString()}</td><td className="p-2">{e.action}</td><td className="p-2 break-all">{e.subject}</td><td className="p-2 break-all">{e.admin_ref??'—'}</td></tr>)}</tbody></table></div>{cursor&&<button className="button mt-4" disabled={busy} onClick={async()=>{setBusy(true);try{const data=await read<{events:Event[];nextCursor:string|null}>('/api/admin/audit?cursor='+encodeURIComponent(cursor));setEvents(old=>[...old,...data.events]);setCursor(data.nextCursor)}catch(e){setError(e instanceof Error?e.message:'Could not load audit history')}finally{setBusy(false)}}}>Load older events</button>}</section>
  </main></>;
}
