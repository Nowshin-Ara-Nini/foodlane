import type { AuthEnvironment } from './auth';
import { authOrigin, digestToken, safeReturnPath, AuthUnavailableError } from './auth-policy';

class AccountUnavailableError extends Error {}
const sessionCookie = 'foodlane_session';
const verifierCookie = 'foodlane_pkce';
const stateCookie = 'foodlane_oauth_state';
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
type ProviderUser = { id: string; email?: string; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> };
type ProviderSession = { access_token: string; refresh_token: string; expires_in: number; user: ProviderUser };
type ProviderPayload = { access_token?: string; refresh_token?: string; expires_in?: number; user?: ProviderUser; id?: string; email_confirmed_at?: string | null; user_metadata?: Record<string,unknown>; app_metadata?: Record<string,unknown> };
type LocalUser = { id:string; name:string; email:string; image:string|null; phone:string|null; role:string; role_chosen:number };
type SessionRow = { id: string; expires_at: number; created_at: number; user_id: string; provider_access_token: string | null; provider_refresh_token: string | null; provider_expires_at: number | null };

function config(env: AuthEnvironment) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase Auth is not configured.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid Supabase project URL.');
  return { url: parsed.origin, key };
}
async function providerRequest(env: AuthEnvironment, path: string, options: { method?: string; body?: unknown; accessToken?: string; redirectTo?: string } = {}) {
  const { url, key } = config(env);
  const target = new URL(`/auth/v1${path}`, url);
  if (options.redirectTo) target.searchParams.set('redirect_to', options.redirectTo);
  const headers = new Headers({ apikey: key, 'Content-Type': 'application/json' });
  if (options.accessToken) headers.set('Authorization', `Bearer ${options.accessToken}`);
  const response = await fetch(target, { method: options.method ?? 'GET', headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), redirect: 'manual' });
  const text = await response.text();
  let data: ProviderPayload | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Provider errors are handled as generic auth failures. */ }
  return { response, data };
}
function base64url(bytes: Uint8Array) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) };
}
function cookieValue(headers: Headers, name: string) {
  const raw = headers.get('cookie') ?? '';
  for (const item of raw.split(';')) { const [key, ...rest] = item.trim().split('='); if (key === name) { try { return decodeURIComponent(rest.join('=')); } catch { return null; } } }
  return null;
}
function cookie(name: string, value: string, env: AuthEnvironment, maxAge: number) {
  const origin = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
function clearCookie(name: string, env: AuthEnvironment) { return cookie(name, '', env, 0); }
function json(body: unknown, status = 200, headers?: HeadersInit) { const result = new Headers(privateHeaders); new Headers(headers).forEach((v, k) => result.set(k, v)); return Response.json(body, { status, headers: result }); }
function responseWithCookies(body: unknown, cookies: string[], status = 200) { const headers = new Headers(privateHeaders); for (const value of cookies) headers.append('Set-Cookie', value); return Response.json(body, { status, headers }); }
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function storeProviderUser(env: AuthEnvironment, providerUser: ProviderUser) {
  if (!providerUser.id || !providerUser.email || !providerUser.email_confirmed_at) throw new Error('Verified provider identity required.');
  const metadata = providerUser.user_metadata ?? {};
  const profileName = metadata.name ?? metadata.full_name;
  const name = typeof profileName === 'string' && profileName.trim() ? profileName.trim().slice(0, 100) : providerUser.email.slice(0, 100);
  const suppliedImage = metadata.avatar_url ?? metadata.picture;
  let image: string | null = null;
  if (typeof suppliedImage === 'string' && suppliedImage.length <= 2048) {
    try {
      const parsed = new URL(suppliedImage);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'googleusercontent.com' || parsed.hostname.endsWith('.googleusercontent.com'))) image = parsed.toString();
    } catch { /* Ignore malformed provider profile photos. */ }
  }
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO auth_users(id,name,email,email_verified,image,role,role_chosen,created_at,updated_at)
    SELECT ?,?,?,1,?,'buyer',0,?,? WHERE NOT EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,email_verified=1,image=CASE WHEN auth_users.role_chosen=0 THEN COALESCE(auth_users.image,excluded.image) ELSE auth_users.image END,updated_at=excluded.updated_at WHERE auth_users.account_status='active'`)
    .bind(providerUser.id, name, providerUser.email.trim().toLowerCase(), image, now, now, providerUser.id).run();
  const allowed = await env.DB.prepare("SELECT id FROM auth_users WHERE id=? AND account_status='active' AND NOT EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=auth_users.id)").bind(providerUser.id).first();
  if (!allowed) throw new AccountUnavailableError();
}
async function createLocalSession(env: AuthEnvironment, session: ProviderSession, request: Request) {
  await storeProviderUser(env, session.user);
  const raw = randomToken(), now = Date.now(), id = crypto.randomUUID();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const accessExpiresAt = now + Math.max(60, Number(session.expires_in) || 3600) * 1000;
  const saved = await env.DB.prepare(`INSERT INTO auth_sessions(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id,provider_access_token,provider_refresh_token,provider_expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_users WHERE id=? AND account_status='active') AND NOT EXISTS(SELECT 1 FROM account_deletion_jobs WHERE user_id=?)`).bind(id, expiresAt, await digestToken(raw), now, now, request.headers.get('cf-connecting-ip'), request.headers.get('user-agent')?.slice(0, 300) ?? null, session.user.id, session.access_token, session.refresh_token, accessExpiresAt, session.user.id, session.user.id).run();
  if (!saved.meta.changes) throw new AccountUnavailableError();
  return cookie(sessionCookie, raw, env, 30 * 24 * 60 * 60);
}
async function loadSession(env: AuthEnvironment, headers: Headers): Promise<{ user: LocalUser & {emailVerified:boolean}; session: SessionRow } | null> {
  const raw = cookieValue(headers, sessionCookie);
  if (!raw || raw.length > 256) return null;
  let row = await env.DB.prepare(`SELECT id,expires_at,created_at,user_id,provider_access_token,provider_refresh_token,provider_expires_at FROM auth_sessions WHERE token=? AND expires_at>? AND EXISTS(SELECT 1 FROM auth_users WHERE id=auth_sessions.user_id AND account_status='active')`)
    .bind(await digestToken(raw), Date.now()).first<SessionRow>();
  if (!row?.provider_access_token || !row.provider_refresh_token) return null;
  if ((row.provider_expires_at ?? 0) < Date.now() + 30_000) {
    const oldRefresh = row.provider_refresh_token;
    const refreshed = await providerRequest(env, '/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: oldRefresh } });
    if (refreshed.response.status === 429 || refreshed.response.status >= 500) throw new AuthUnavailableError();
    if (!refreshed.response.ok || !refreshed.data?.access_token || !refreshed.data?.refresh_token) {
      await env.DB.prepare('DELETE FROM auth_sessions WHERE id=? AND provider_refresh_token=?').bind(row.id, oldRefresh).run();
      return null;
    }
    const updated = await env.DB.prepare(`UPDATE auth_sessions SET provider_access_token=?,provider_refresh_token=?,provider_expires_at=?,updated_at=? WHERE id=? AND provider_refresh_token=?`)
      .bind(refreshed.data.access_token, refreshed.data.refresh_token, Date.now() + Math.max(60, Number(refreshed.data.expires_in) || 3600) * 1000, Date.now(), row.id, oldRefresh).run();
    if (!updated.meta.changes) {
      row = await env.DB.prepare(`SELECT id,expires_at,created_at,user_id,provider_access_token,provider_refresh_token,provider_expires_at FROM auth_sessions WHERE id=? AND expires_at>?`).bind(row.id, Date.now()).first<SessionRow>();
      if (!row?.provider_access_token) return null;
    } else {
      row.provider_access_token = refreshed.data.access_token;
      row.provider_refresh_token = refreshed.data.refresh_token;
      row.provider_expires_at = Date.now() + Math.max(60, Number(refreshed.data.expires_in) || 3600) * 1000;
    }
  }
  const checked = await providerRequest(env, '/user', { accessToken: row.provider_access_token! });
  if (checked.response.status === 429 || checked.response.status >= 500) throw new AuthUnavailableError();
  if (!checked.response.ok || checked.data?.id !== row.user_id || !checked.data?.email_confirmed_at) {
    if (checked.response.status === 401 || checked.response.status === 403) await env.DB.prepare('DELETE FROM auth_sessions WHERE id=?').bind(row.id).run();
    return null;
  }
  await storeProviderUser(env, checked.data as ProviderUser);
  const localUser = await env.DB.prepare('SELECT id,name,email,image,phone,role,role_chosen FROM auth_users WHERE id=? AND email_verified=1 AND account_status=\'active\'').bind(row.user_id).first<LocalUser>();
  if (!localUser || !['buyer', 'seller', 'admin'].includes(localUser.role)) return null;
  return { user: { ...localUser, emailVerified: true }, session: row };
}
export async function supabaseSessionUser(headers: Headers, env: AuthEnvironment) {
  if (!cookieValue(headers, sessionCookie)) return null;
  const session = await loadSession(env, headers);
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image?.startsWith('profile/') ? '/api/account/profile-photo' : session.user.image ?? null, phone: session.user.phone ?? null, role: session.user.role, roleChosen: !!session.user.role_chosen, sessionId: session.session.id, sessionCreatedAt: session.session.created_at };
}
export async function deleteSupabaseAccount(env: AuthEnvironment, userId: string) {
  const { url } = config(env);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('Supabase account deletion is not configured.');
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: { apikey: secret }, redirect: 'manual',
  });
  if (!response.ok && response.status !== 404) throw new Error('Supabase account deletion failed.');
}
async function requestBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Invalid body');
  const reader = request.body?.getReader(); if (!reader) throw new Error('Invalid body');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 16_384) { await reader.cancel(); throw new Error('Invalid body'); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
  return value as Record<string, unknown>;
}
async function makeFlowCookie(env: AuthEnvironment) {
  const pair = await pkce();
  const flowState = randomToken();
  return { ...pair, state: flowState, cookies: [cookie(verifierCookie, pair.verifier, env, 600), cookie(stateCookie, flowState, env, 600)] };
}
export async function handleSupabaseAuth(request: Request, env: AuthEnvironment) {
  try {
    const origin = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
    const url = new URL(request.url);
    if (url.origin !== origin) return json({ error: 'Invalid request origin.' }, 403);
    if (url.href.length > 4096) return json({ error: 'Invalid request.' }, 400);
    const path = url.pathname.slice('/api/auth'.length);
    const ip = request.headers.get('cf-connecting-ip') ?? 'local-or-unknown';
    const limit = async (value: string, max: number, seconds: number) => {
      const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(value));
      const key = Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, '0')).join('');
      const now = Date.now();
      const row = await env.DB.prepare(`INSERT INTO auth_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at`).bind(key, now + seconds * 1000, now, now).first<{ count: number; expires_at: number }>();
      return row && row.count > max ? Math.max(1, Math.ceil((row.expires_at - now) / 1000)) : 0;
    };
    const ipRetry = await limit(`auth:ip:${ip}`, 100, 60);
    if (ipRetry) return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), { status: 429, headers: { ...privateHeaders, 'Content-Type': 'application/json', 'Retry-After': String(ipRetry) } });
    if (request.method === 'POST' && path === '/sign-in/social') {
      const retry = await limit(`auth:social:${ip}`, 20, 60);
      if (retry) return new Response(JSON.stringify({ error: 'Too many sign-in attempts. Try again later.' }), { status: 429, headers: { ...privateHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retry) } });
    }
    if (request.method === 'POST' && !['/sign-in/social','/sign-out'].includes(path)) return json({ error: 'Not found.' }, 404);
    if (request.method === 'GET' && path === '/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('flow_state');
      const expected = cookieValue(request.headers, stateCookie), verifier = cookieValue(request.headers, verifierCookie);
      if (!code || !expected || !state || state !== expected || !verifier) return Response.redirect(`${origin}/auth/login?error=callback`, 303);
      const exchanged = await providerRequest(env, '/token?grant_type=pkce', { method: 'POST', body: { auth_code: code, code_verifier: verifier } });
      if (!exchanged.response.ok || !exchanged.data?.access_token || !exchanged.data?.user) return Response.redirect(`${origin}/auth/login?error=callback`, 303);
      const sessionCookieValue = await createLocalSession(env, exchanged.data as ProviderSession, request);
      const next = new URL('/auth/choose-role', origin);
      next.searchParams.set('returnTo', safeReturnPath(url.searchParams.get('returnTo')));
      const response = new Response(null, { status: 303, headers: { Location: next.toString(), ...privateHeaders } });
      response.headers.append('Set-Cookie', sessionCookieValue);
      response.headers.append('Set-Cookie', clearCookie(verifierCookie, env));
      response.headers.append('Set-Cookie', clearCookie(stateCookie, env));
      return response;
    }
    if (request.method === 'GET' && path === '/get-session') {
      const current = await loadSession(env, request.headers);
      return json(current ? { user: { id: current.user.id, name: current.user.name, image: current.user.image ?? null, role: current.user.role, roleChosen: !!current.user.role_chosen, emailVerified: true }, session: { id: current.session.id, createdAt: new Date(current.session.created_at).toISOString() } } : null);
    }
    if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
    if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Invalid request origin.' }, 403);
    const body = await requestBody(request);
    if ('role' in body || 'roleChosen' in body || ('signupRole' in body && !['buyer', 'seller'].includes(String(body.signupRole)))) return json({ error: 'Choose buyer or seller. Roles cannot be changed here.' }, 400);
    if (path === '/sign-in/social') {
      if (body.provider !== 'google') return json({ error: 'Unsupported sign-in provider.' }, 400);
      const flow = await makeFlowCookie(env);
      const returnTo = safeReturnPath(typeof body.returnTo === 'string' ? body.returnTo : null);
      const redirectTo = new URL('/api/auth/callback', origin); redirectTo.searchParams.set('next', '/auth/choose-role'); redirectTo.searchParams.set('returnTo', returnTo); redirectTo.searchParams.set('flow_state', flow.state);
      const { url: projectUrl, key } = config(env); const authorize = new URL('/auth/v1/authorize', projectUrl);
      authorize.searchParams.set('provider', 'google'); authorize.searchParams.set('redirect_to', redirectTo.toString());
      authorize.searchParams.set('code_challenge', flow.challenge); authorize.searchParams.set('code_challenge_method', 's256'); authorize.searchParams.set('apikey', key);
      return responseWithCookies({ url: authorize.toString() }, flow.cookies);
    }
    if (path === '/sign-out') {
      const raw = cookieValue(request.headers, sessionCookie);
      const session = raw && raw.length <= 256 ? await env.DB.prepare('SELECT id,provider_access_token FROM auth_sessions WHERE token=?').bind(await digestToken(raw)).first<{id:string;provider_access_token:string|null}>() : null;
      const current = session ? {session} : null;
      if (current?.session.provider_access_token) await providerRequest(env, '/logout?scope=local', { method: 'POST', accessToken: current.session.provider_access_token }).catch(() => null);
      if (current) await env.DB.prepare('DELETE FROM auth_sessions WHERE id=?').bind(current.session.id).run();
      return responseWithCookies({ success: true }, [clearCookie(sessionCookie, env), clearCookie(verifierCookie, env), clearCookie(stateCookie, env)]);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof AccountUnavailableError) return Response.redirect(`${new URL(env.AUTH_BASE_URL).origin}/auth/login?error=account-unavailable`, 303);
    console.error('AUTH_REQUEST_FAILED');
    return json({ error: 'Authentication is temporarily unavailable. Please try again.' }, 503);
  }
}



