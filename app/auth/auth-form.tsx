'use client';
import { useState } from 'react';
import { Utensils } from 'lucide-react';
import Link from 'next/link';
import { safeReturnPath } from '../../lib/auth-policy';

type Screen = 'login' | 'signup';
async function startGoogleSignIn(body: Record<string, unknown>) {
  const response = await fetch('/api/auth/sign-in/social', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as { error?: string; url?: string };
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Unable to start Google sign-in. Try again.');
  return data;
}
export default function AuthForm({ screen, initialError }: { screen: Screen; initialError?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError === 'account-unavailable' ? 'This Foodlane account is banned or being deleted. Contact Foodlane if you need help.' : initialError ? 'Sign-in could not finish. Please try again.' : '');
  async function google() {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams(window.location.search);
      const data = await startGoogleSignIn({ provider: 'google', returnTo: safeReturnPath(query.get('returnTo')) });
      if (!data.url) throw new Error('Google sign-in is not configured yet.');
      window.location.assign(data.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Please try again.'); setBusy(false); }
  }
  return <main className="mx-auto max-w-lg px-5 py-12">
    <Link className="brand" href="/"><span className="brand-icon"><Utensils /></span>foodlane<span>.</span></Link>
    <section className="panel mt-8"><h1>{screen === 'login' ? 'Welcome back' : 'Join Foodlane'}</h1>
      <p className="mt-3">Sign in securely with your Google account. On your first visit, you’ll choose your Foodlane name, profile photo, and whether you’re a buyer or seller.</p>
      {error && <p role="alert" className="status-message">{error}</p>}
      <button type="button" className="button primary mt-5 w-full" disabled={busy} onClick={google}>{busy ? 'Connecting to Google…' : 'Continue with Google'}</button>
      <p className="mt-4 text-sm">Sellers complete Foodlane’s private identity and selling-place review before they can publish food.</p>
      <nav className="mt-6 flex gap-4 text-sm" aria-label="Account links">
        {screen === 'login' ? <Link href="/auth/signup">Create an account</Link> : <Link href="/auth/login">Already have an account? Sign in</Link>}
      </nav>
    </section>
  </main>;
}
