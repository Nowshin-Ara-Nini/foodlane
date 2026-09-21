'use client';
import { useState, type FormEvent } from 'react';
import { Utensils } from 'lucide-react';
import Link from 'next/link';
import { safeReturnPath } from '../../lib/auth-policy';

type Screen = 'login' | 'signup' | 'forgot-password' | 'reset-password' | 'verify' | 'resend';
const titles: Record<Screen, string> = { login: 'Welcome back', signup: 'Create your account', 'forgot-password': 'Reset your password', 'reset-password': 'Choose a new password', verify: 'Verify your email', resend: 'Resend verification email' };
async function call(path: string, body: Record<string, unknown>) {
  const response = await fetch('/api/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json() as { error?: string; message?: string; url?: string };
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Unable to complete this request. Try again.');
  return data;
}
export default function AuthForm({ screen }: { screen: Screen }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    const query = new URLSearchParams(window.location.search);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    try {
      if (screen === 'login') {
        await call('sign-in/email', { email, password });
        window.location.assign(safeReturnPath(query.get('returnTo')));
      } else if (screen === 'signup') {
        const data = await call('sign-up/email', { email, password, name: form.get('name'), callbackURL: '/auth/login' });
        setMessage(data.message ?? 'Check your email.'); setDone(true);
      } else if (screen === 'forgot-password') {
        const data = await call('request-password-reset', { email, redirectTo: window.location.origin + '/auth/reset-password' });
        setMessage(data.message ?? 'Check your email.'); setDone(true);
      } else if (screen === 'resend') {
        const data = await call('send-verification-email', { email, callbackURL: '/auth/login' });
        setMessage(data.message ?? 'Check your email.'); setDone(true);
      } else if (screen === 'reset-password') {
        await call('reset-password', { token: query.get('token'), newPassword: password });
        window.history.replaceState(null, '', window.location.pathname);
        setMessage('Your password was reset. Sign in with your new password.'); setDone(true);
      } else {
        await call('verify-email', { token: query.get('token') });
        window.history.replaceState(null, '', window.location.pathname);
        setMessage('Your email is verified. You can now sign in.'); setDone(true);
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  async function google() {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams(window.location.search);
      const data = await call('sign-in/social', { provider: 'google', callbackURL: window.location.origin + safeReturnPath(query.get('returnTo')), errorCallbackURL: window.location.origin + '/auth/login' });
      if (!data.url) throw new Error('Google sign-in is not configured yet.');
      window.location.assign(data.url);
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); setBusy(false); }
  }
  return <main className="mx-auto max-w-lg px-5 py-12">
    <Link className="brand" href="/"><span className="brand-icon"><Utensils /></span>foodlane<span>.</span></Link>
    <section className="panel mt-8"><h1>{titles[screen]}</h1>
      {error && <p role="alert" className="status-message">{error}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {!done && <form onSubmit={submit} className="stack mt-5">
        {screen === 'signup' && <label className="field">Display name<input name="name" required maxLength={100} autoComplete="name" /></label>}
        {!['verify', 'reset-password'].includes(screen) && <label className="field">Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>}
        {['login', 'signup', 'reset-password'].includes(screen) && <label className="field">Password<input name="password" type="password" required minLength={screen === 'login' ? 1 : 12} maxLength={128} autoComplete={screen === 'login' ? 'current-password' : 'new-password'} />{screen !== 'login' && <small>Use 12–128 characters.</small>}</label>}
        {screen === 'verify' && <p>Confirm your email address to activate your account. This link can be used once and expires after one hour.</p>}
        <button className="button primary" disabled={busy}>{busy ? 'Please wait…' : screen === 'verify' ? 'Verify email' : screen === 'login' ? 'Sign in' : screen === 'signup' ? 'Create account' : screen === 'reset-password' ? 'Save password' : 'Send email'}</button>
      </form>}
      {['login', 'signup'].includes(screen) && !done && <button className="button mt-4 w-full" disabled={busy} onClick={google}>Continue with Google</button>}
      <nav className="mt-6 flex flex-wrap gap-4 text-sm" aria-label="Account links">
        {screen !== 'login' && <Link href="/auth/login">Sign in</Link>}
        {screen === 'login' && <><Link href="/auth/signup">Create an account</Link><Link href="/auth/forgot-password">Forgot password?</Link><Link href="/auth/resend">Verify your email</Link></>}
      </nav>
    </section>
  </main>;
}
