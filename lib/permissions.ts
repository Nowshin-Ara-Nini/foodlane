import { type AuthEnvironment } from './auth';
import { supabaseSessionUser } from './supabase-auth';

export type Role = 'buyer' | 'seller' | 'admin';
export type AppUser = { userId: string; name: string; email?: string; image?: string | null; phone?: string | null; role: Role; roleChosen: boolean; sessionId:string; sessionCreatedAt:number };
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function sessionUser(headers: Headers, env: AuthEnvironment): Promise<AppUser | null> {
  if (!headers.get('cookie')) return null;
  // The legacy auth adapter exists only for the existing isolated D1 test harness.
  // No production configuration sets this binding.
  if (env.TEST_ONLY_BETTER_AUTH === 'true') {
    const { createAuth } = await import('./auth');
    const session = await createAuth(env).api.getSession({ headers });
    if (!session?.user.emailVerified) return null;
    const user = await env.DB.prepare('SELECT id,name,email,image,phone,role,role_chosen FROM auth_users WHERE id=? AND email_verified=1 AND account_status=\'active\'').bind(session.user.id).first<{id:string;name:string;email:string;image:string|null;phone:string|null;role:string;role_chosen:number}>();
    if (!user || !['buyer','seller','admin'].includes(user.role)) return null;
    return { sessionId:session.session.id,sessionCreatedAt:new Date(session.session.createdAt).getTime(),userId:user.id,name:user.name,email:user.email,image:user.image,phone:user.phone,role:user.role as Role,roleChosen:!!user.role_chosen };
  }
  const user = await supabaseSessionUser(headers, env);
  if (!user || !['buyer', 'seller', 'admin'].includes(user.role)) return null;
  return { ...user, role: user.role as Role };
}
export function requireRole(user: AppUser | null, role: Role): AppUser {
  if (!user || !user.roleChosen || user.role !== role) throw new HttpError(403, `${role} access required.`);
  return user;
}
export function requireIdentity(user: AppUser | null): AppUser {
  if (!user) throw new HttpError(401, 'Sign in with a verified email.');
  return user;
}
