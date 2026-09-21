import { createAuth, type AuthEnvironment } from './auth';

export type Role = 'buyer' | 'seller' | 'admin';
export type AppUser = { userId: string; name: string; role: Role; roleChosen: boolean };
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function sessionUser(headers: Headers, env: AuthEnvironment): Promise<AppUser | null> {
  if (!headers.get('cookie')) return null;
  const session = await createAuth(env).api.getSession({ headers });
  if (!session?.user.emailVerified) return null;
  // Re-read the current role rather than trusting a stale cookie or user-supplied field.
  const user = await env.DB.prepare('SELECT id, name, role, role_chosen FROM auth_users WHERE id = ? AND email_verified = 1')
    .bind(session.user.id).first<{ id: string; name: string; role: string; role_chosen: number }>();
  if (!user || !['buyer', 'seller', 'admin'].includes(user.role)) return null;
  return { userId: user.id, name: user.name, role: user.role as Role, roleChosen: !!user.role_chosen };
}
export function requireRole(user: AppUser | null, role: Role): AppUser {
  if (!user || !user.roleChosen || user.role !== role) throw new HttpError(403, `${role} access required.`);
  return user;
}
export function requireIdentity(user: AppUser | null): AppUser {
  if (!user) throw new HttpError(401, 'Sign in with a verified email.');
  return user;
}
