import { createAuth, type AuthEnvironment } from './auth';
import { authOrigin, digestToken } from './auth-policy';

const publicPosts = new Set(['/sign-up/email', '/sign-in/email', '/sign-in/social', '/sign-out', '/request-password-reset', '/reset-password', '/send-verification-email', '/verify-email']);
const publicGets = new Set(['/get-session', '/callback/google', '/error']);
const genericPaths = new Set(['/sign-up/email', '/request-password-reset', '/send-verification-email']);
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: privateHeaders }); }

async function limit(env: AuthEnvironment, value: string, max: number, seconds: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  const fingerprint = Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO auth_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count, expires_at`)
    .bind(fingerprint, now + seconds * 1000, now, now).first<{ count: number; expires_at: number }>();
  if (!row || row.count > max) return Math.max(1, Math.ceil(((row?.expires_at ?? now + 60000) - now) / 1000));
  return 0;
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Invalid body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 16384) { await reader.cancel(); throw new Error('Invalid body'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid body');
  return data as Record<string, unknown>;
}

export async function handleAuth(request: Request, env: AuthEnvironment, auth = createAuth(env)) {
  try {
    const base = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
    const url = new URL(request.url);
    if (url.origin !== base) return json({ error: 'Invalid request origin.' }, 403);
    if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
    const path = url.pathname.slice('/api/auth'.length);
    if (!(request.method === 'POST' ? publicPosts : publicGets).has(path)) return json({ error: 'Not found.' }, 404);
    if (request.method === 'POST' && (request.headers.get('origin') !== base || request.headers.get('sec-fetch-site') === 'cross-site')) return json({ error: 'Invalid request origin.' }, 403);
    // Cloudflare overwrites this header at ingress. Never trust forwarded IP headers.
    const ip = request.headers.get('cf-connecting-ip') ?? 'local-or-unknown';
    let retry = await limit(env, `ip:${ip}`, 100, 60);
    if (!retry && request.method === 'POST') {
      const sensitive = ['/sign-in/email', '/sign-up/email', '/request-password-reset', '/send-verification-email', '/reset-password', '/verify-email'].includes(path);
      retry = await limit(env, `ip:${ip}:${path}`, sensitive ? 5 : 20, sensitive ? 600 : 60);
    }
    if (retry) return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), { status: 429, headers: { ...privateHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retry) } });
    let forwarded = request;
    if (request.method === 'POST') {
      let body: Record<string, unknown>;
      try { body = await boundedJson(request); } catch { return json({ error: 'Invalid request.' }, 400); }
      if ('role' in body || 'roleChosen' in body || ('signupRole' in body && !['buyer', 'seller'].includes(String(body.signupRole)))) {
        return json({ error: 'Choose buyer or seller. Roles cannot be changed here.' }, 400);
      }
      if (typeof body.email === 'string') {
        body.email = body.email.trim().toLowerCase();
        retry = await limit(env, `email:${path}:${body.email}`, 5, 600);
        if (retry) return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), { status: 429, headers: { ...privateHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retry) } });
      }
      if (path === '/verify-email') {
        if (typeof body.token !== 'string' || body.token.length > 4096) return json({ error: 'Invalid or expired link.' }, 400);
        const consumed = await env.DB.prepare('DELETE FROM auth_email_links WHERE digest = ? AND expires_at > ? RETURNING digest')
          .bind(await digestToken(body.token), Date.now()).first();
        if (!consumed) return json({ error: 'Invalid or expired link.' }, 400);
        const target = new URL('/api/auth/verify-email', base);
        target.searchParams.set('token', body.token);
        forwarded = new Request(target, { headers: request.headers });
      } else {
        forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) });
      }
    }
    const response = await auth.handler(forwarded);
    // Best effort expiry cleanup, with no user data or token values in logs.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_limits WHERE expires_at < ?').bind(Date.now() - 86400000),
      env.DB.prepare('DELETE FROM auth_email_links WHERE expires_at < ?').bind(Date.now()),
    ]).catch(() => { console.error('AUTH_EXPIRY_CLEANUP_FAILED'); });
    if (genericPaths.has(path)) {
      // Delivery failures must not disclose that an address has an account.
      if (response.status >= 500) console.error('AUTH_EMAIL_REQUEST_FAILED');
      return json({ message: 'If this address is eligible, an email will arrive shortly.' });
    }
    if (path === '/sign-in/email' && response.status >= 400 && response.status < 500) return json({ error: 'Unable to sign in. Check your credentials and verify your email.' }, 401);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    console.error('AUTH_REQUEST_FAILED');
    return json({ error: 'Authentication is temporarily unavailable. Please try again.' }, 503);
  }
}
