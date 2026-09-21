'use client';
import { useState } from 'react';
export default function ChooseRole({ returnTo }: { returnTo: string }) {
  const [role, setRole] = useState('buyer'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <main className="shell"><form className="panel stack" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/account/role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
      if (!response.ok) throw new Error('Unable to select your role. Refresh and try again.');
      window.location.assign(returnTo === '/' && role === 'seller' ? '/seller' : returnTo);
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); setBusy(false); }
  }}><h1>Choose your Foodlane account</h1><p>This is a one-time choice. Seller applicants must be 18 or older, and must be approved before appearing publicly.</p>
    <label className="field">Account type<select value={role} onChange={event => setRole(event.target.value)}><option value="buyer">Buyer</option><option value="seller">Seller</option></select></label>
    <p>Buyer accounts can leave reviews and show interest. Seller accounts manage their own food listings.</p>
    {error && <p role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
  </form></main>;
}
