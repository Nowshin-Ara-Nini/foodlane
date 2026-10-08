import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/auth-schema';
import { authOrigin, digestToken } from './auth-policy';

export interface AuthEnvironment {
  DB: D1Database;
  AUTH_BASE_URL: string;
  BETTER_AUTH_SECRET: string;
  AUTH_ALLOW_LOCAL_HTTP?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY: string;
  AUTH_EMAIL_FROM: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  TEST_ONLY_BETTER_AUTH?: string;
}

export type AuthMail = { to: string; subject: string; text: string };
export async function deliverAuthMail(env:AuthEnvironment,mail:AuthMail) {
    if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) throw new Error('Email service is not configured.');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.AUTH_EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!response.ok) throw new Error('Email delivery failed.');
}
export function createAuth(env: AuthEnvironment, sendMail?: (mail: AuthMail) => Promise<void>) {
  const baseURL = authOrigin(env.AUTH_BASE_URL, env.AUTH_ALLOW_LOCAL_HTTP === 'true');
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error('Auth secret is missing or too short.');
  const deliver = sendMail ?? ((mail:AuthMail) => deliverAuthMail(env,mail));
  return betterAuth({
    appName: 'Foodlane',
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB), { provider: 'sqlite', schema, transaction: false }),
    trustedOrigins: [baseURL],
    // Atomic D1 limits are enforced before this handler (including development).
    rateLimit: { enabled: false },
    logger: { disabled: true },
    advanced: {
      useSecureCookies: baseURL.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, secure: baseURL.startsWith('https:'), sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    user: { additionalFields: {
      role: { type: 'string', required: true, defaultValue: 'buyer', input: false },
      roleChosen: { type: 'boolean', required: true, defaultValue: false, input: false },
    } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 60 * 30,
      revokeSessionsOnPasswordReset: true,
      // No password override: use Better Auth's standard scrypt parameters.
      sendResetPassword: async ({ user, token }) => {
        const link = new URL('/auth/reset-password', baseURL);
        link.searchParams.set('token', token);
        await deliver({ to: user.email, subject: 'Reset your Foodlane password', text: `Reset your password within 30 minutes:\n${link}\n\nIf you did not request this, ignore this email.` });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url, token }) => {
        await env.DB.prepare('INSERT INTO auth_email_links (digest, expires_at) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING')
          .bind(await digestToken(token), Date.now() + 60 * 60 * 1000).run();
        // Verification requires a user gesture on our page, not an email-scanner GET.
        const link = new URL('/auth/verify', baseURL);
        link.searchParams.set('token', token);
        const callback = new URL(url).searchParams.get('callbackURL');
        if (callback) link.searchParams.set('callbackURL', callback);
        await deliver({ to: user.email, subject: 'Verify your Foodlane email', text: `Verify your email within one hour:\n${link}\n\nIf you did not request this, ignore this email.` });
      },
    },
    socialProviders: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        requireEmailVerification: true,
        mapProfileToUser: (profile) => ({ emailVerified: profile.email_verified === true }),
      },
    } : {},
    databaseHooks: {
      user: { create: { before: async (user, context) => {
        if (context?.path === '/sign-up/email') {
          const choice = context.body?.signupRole ?? 'buyer';
          if (choice !== 'buyer' && choice !== 'seller') return false;
          return { data: { ...user, role: choice, roleChosen: true } };
        }
        // OAuth onboarding happens after identity verification, once per account.
        return { data: { ...user, role: 'buyer', roleChosen: false } };
      } } },
      session: { create: { before: async (session) => {
        const user = await env.DB.prepare('SELECT email_verified FROM auth_users WHERE id = ?').bind(session.userId).first<{ email_verified: number }>();
        if (!user?.email_verified) return false;
        return { data: session };
      } } },
    },
  });
}
