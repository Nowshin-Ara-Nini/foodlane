'use client';
import { useState } from 'react';
export default function SignOut() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <><button className="button" disabled={busy} onClick={async () => {
    setBusy(true); setError(false);
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error();
      // Full navigation discards any previously loaded authenticated client state.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/');
    } catch { setBusy(false); setError(true); }
  }}>{busy ? 'Signing out…' : 'Sign out'}</button>{error && <span role="alert">Could not sign out. Try again.</span>}</>;
}
