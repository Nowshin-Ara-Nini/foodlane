'use client';
import { useState } from 'react';
import ImageUpload from '../../image-upload';
/* eslint-disable @next/next/no-img-element -- Provider photos are validated HTTPS profile images. */
export default function ChooseRole({ returnTo, name: initialName, email, image }: { returnTo: string; name: string; email?: string; image?: string | null }) {
  const [role, setRole] = useState<'buyer' | 'seller'>('buyer');
  const [name, setName] = useState(initialName), [phone,setPhone]=useState('');
  const [useGooglePhoto, setUseGooglePhoto] = useState(Boolean(image && !image.startsWith('/api/')));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <main className="shell"><form className="panel stack" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form=new FormData(event.currentTarget);
      form.set('role',role);form.set('name',name);form.set('phone',phone);form.set('useGooglePhoto',String(useGooglePhoto));
      const response = await fetch('/api/account/role', { method: 'POST', body: form });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Unable to save your profile. Refresh and try again.');
      window.location.assign(role === 'seller' ? '/seller?start=verification' : returnTo);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); setBusy(false); }
  }}>
    <h1>Set up your Foodlane profile</h1><p>Your Google account confirms your email. Choose the name and account details Foodlane should use.</p>
    {email && <p className="small">Google account: {email}</p>}
    {image && useGooglePhoto && <img src={image} alt="Your Google profile photo" width="88" height="88" referrerPolicy="no-referrer" className="rounded-full"/>}
    {image && !image.startsWith('/api/') && <label className="field flex-row"><input type="checkbox" checked={useGooglePhoto} onChange={event => setUseGooglePhoto(event.target.checked)}/> Use my Google profile photo on Foodlane</label>}
    <label className="field">Profile name<input value={name} onChange={event => setName(event.target.value)} required maxLength={100} autoComplete="name"/></label>
    <label className="field">Mobile number<input type="tel" value={phone} onChange={event=>setPhone(event.target.value)} required={role==='buyer'} maxLength={32} autoComplete="tel" placeholder="+880 1XXXXXXXXX"/></label>
    <ImageUpload name="profilePhoto" label="Profile photo (optional)" help="JPEG or PNG, up to 5 MB. Your photo is private to your account unless you choose to share it."/>
    <label className="field">Account type<select value={role} onChange={event => setRole(event.target.value as 'buyer' | 'seller')}><option value="buyer">Buyer — browse, review and show interest</option><option value="seller">Seller — apply to list food (18+)</option></select></label>
    {role === 'seller' ? <p>Next, complete your seller profile and submit the private identity and selling-place verification documents. An admin must approve you before your listings appear.</p> : <p>Buyers can browse local food, show interest, and review sellers. Add your mobile number so sellers can coordinate with you when needed.</p>}
    {error && <p role="alert" className="status-message">{error}</p>}
    <button className="button primary" disabled={busy || !name.trim() || (role==='buyer'&&!phone.trim())}>{busy ? 'Saving…' : role === 'seller' ? 'Continue to seller setup' : 'Continue as buyer'}</button>
  </form></main>;
}
