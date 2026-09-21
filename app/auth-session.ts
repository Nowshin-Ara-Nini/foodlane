import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { type AuthEnvironment } from '../lib/auth';
import { safeReturnPath } from '../lib/auth-policy';
import { sessionUser, type Role } from '../lib/permissions';

export function authEnvironment(): AuthEnvironment {
  if (!env.DB || !env.AUTH_BASE_URL || !env.BETTER_AUTH_SECRET) throw new Error('Authentication is not configured.');
  return { ...env, DB: env.DB, AUTH_BASE_URL: env.AUTH_BASE_URL, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    RESEND_API_KEY: env.RESEND_API_KEY ?? '', AUTH_EMAIL_FROM: env.AUTH_EMAIL_FROM ?? '' };
}
export async function getUser() {
  const requestHeaders = await headers();
  // Anonymous discovery works before secrets are provisioned. Never trust identity headers.
  if (!requestHeaders.get('cookie')) return null;
  return sessionUser(requestHeaders, authEnvironment());
}
export async function requirePageRole(role: Role, returnTo: string) {
  const user = await requireUser(returnTo);
  if (!user.roleChosen) redirect('/auth/choose-role');
  if (user.role !== role) redirect('/forbidden');
  return user;
}
export async function requireUser(returnTo: string) {
  const user = await getUser();
  if (user) return user;
  redirect(`/auth/login?returnTo=${encodeURIComponent(safeReturnPath(returnTo))}`);
}
