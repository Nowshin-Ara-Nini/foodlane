# Supabase Auth setup for Foodlane

Foodlane uses Google OAuth as its only sign-in method. Supabase Auth verifies the Google identity; Foodlane stores a D1 shadow account/role and opaque server session. The browser receives only a random HttpOnly cookie; access and refresh tokens stay server-side in D1.

## Local configuration

The local `.dev.vars` file may use either `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` or the `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` names shown by Supabase. Keep the publishable key in Worker bindings; do not store auth tokens in browser storage. The app also requires the existing `BETTER_AUTH_SECRET` for keyed rate-limit fingerprints and admin MFA encryption.

## Dashboard settings

1. In Supabase, open **Authentication → URL Configuration**. Set the Site URL to the deployed Foodlane origin and add its exact callback URL: `https://foodlane.nowshinaranini.workers.dev/api/auth/callback`. Add `http://localhost:5173/api/auth/callback` only for local development.
2. Under **Authentication → Providers → Google**, enable Google and enter the OAuth client ID and secret. In Google Cloud, use the Supabase callback URI shown in Supabase’s Google provider settings as the authorized redirect URI.
3. Under **Authentication → Providers → Email**, disable Email sign-in if the project should accept Google only. Foodlane's app API rejects email/password, password-reset, and email-verification routes. Supabase SMTP is not used for sign-in.
4. In **Settings → API Keys**, create a server-only secret key. Never expose it to browser code. Foodlane uses it only to delete the matching Supabase Auth account during account deletion.

## First sign-in and seller review

After Google returns a verified identity, new users complete a one-time Foodlane profile setup. Their Google name and photo are prefilled; they can edit the Foodlane name and choose whether to use that Google photo. They then select buyer or seller. A seller is sent to the seller dashboard to save their public business/location profile, then completes the existing private identity and selling-place verification. Admin approval is required before seller listings appear.

The existing seller-verification rules remain in force: applicants must be adults; identity and selling evidence are private and available only to authorized admins; location/photo publication requires explicit consent; passport-photo publication is separate and optional; uploads are sanitized; and sellers remain hidden until approval.

## Cloudflare secrets

For a deployed Worker, run these commands from the repository. Wrangler prompts for each value; do not put secrets in `wrangler.jsonc` or commit them.

```powershell
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_PUBLISHABLE_KEY
wrangler secret put SUPABASE_SECRET_KEY
```

For local development, add the same values to the ignored `.dev.vars` file. `SUPABASE_SECRET_KEY` is required for account deletion. If absent, deletion fails closed and keeps the account data rather than deleting only the D1 copy.

## Cutover and migration

Migration `0010_supabase_auth` stores provider tokens in the server-side D1 session row. It is recorded in Drizzle metadata. Apply locally before testing and remotely only after review:

```powershell
pnpm db:migrate:local
pnpm db:migrate:remote
```

The existing Better Auth tables remain for migration history and role/account compatibility. Existing password identities are not copied. Google OAuth completion, seller onboarding, account deletion, and the worker.dev callback must be verified before enabling public Worker routing.

## Account moderation migration

Migration 0013 adds account status, private ban reasons and durable deletion jobs. Foodlane bans are enforced by D1 on session reads and OAuth completion; they do not change the user's Google account. Provider deletion follows a durable access-revocation transaction, and failures are retried by scheduled cleanup. See [ADMIN_ACCOUNTS_RUNBOOK.md](ADMIN_ACCOUNTS_RUNBOOK.md).
