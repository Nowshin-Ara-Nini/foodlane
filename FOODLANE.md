# Foodlane upgrade

## Approval checkpoints

Implement one step at a time. After each, report changes, checks, limitations and migrations, then wait for explicit owner approval. Do not activate the replacement publicly until all six checkpoints and deployment checks pass.

1. Authentication: current checkpoint.
2. Server-side roles and adult seller eligibility: not started.
3. Private verification, consent, image sanitization and retention: not started.
4. Admin review, mandatory MFA and audit panel: not started.
5. Maps, near-me, seller-level interest/reviews: not started.
6. Abuse protection, account deletion and privacy policy: not started.

## Step 1 implementation

Better Auth 1.7.4 and its Drizzle adapter replace ChatGPT sign-in. This version meets the repository's seven-day dependency-age policy. Existing screens/API handlers resolve verified users from D1 sessions and ignore identity headers.

Account screens: `/auth/login`, `/auth/signup`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify`, `/auth/resend`. Logout is a same-origin POST. Google callback: `/api/auth/callback/google`.

- Standard Better Auth scrypt; passwords 12–128 characters; no weakened parameters.
- Verified email required before sessions are created. Google must provide verified email or the user must complete email verification.
- One-hour signed verification links with atomic single-use redemption. A button click prevents email scanners from consuming them. Password-reset tokens expire after 30 minutes and are single-use.
- Seven-day D1 sessions; HttpOnly, Secure, SameSite=Lax cookies; no cookie session cache or localStorage tokens. Reset revokes existing sessions.
- Exact-origin mutation checks, OAuth state/PKCE protection, account linking disabled.
- Persistent atomic D1 rate limits: 100 auth requests/IP/minute; 5 sensitive requests/IP/endpoint/10 minutes; 5 attempts/email/endpoint/10 minutes. Other POSTs: 20/IP/endpoint/minute. Counter keys are HMACs, not raw IPs/emails. 429 responses include Retry-After.
- Generic signup/resend/reset-request responses. Operational auth logs contain only generic event codes.
- Only implemented authentication endpoints are exposed. Account deletion/management is deferred to its approved step.

## Migration

`drizzle/0004_auth_roles.sql` adds auth users, accounts, sessions, verification tokens, rate-limit counters and verification-link digests. Despite its planned name, role/MFA fields are deferred to their approved steps, using later additive migrations rather than rewriting an applied migration.

```sh
npm run db:migrate:local
npm run db:migrate:remote
```

Run remote migrations only against the intended fresh database after replacing the placeholder ID. Fresh databases first apply 0000–0003. Existing test identities are not mapped. Integration tests use disposable D1 databases.

## Configuration

Direct Cloudflare configuration is in `wrangler.jsonc`. Its compatibility date matches the pinned Workers runtime. Keep workers_dev and preview URLs disabled until the upgrade is complete.

Locally, copy `.dev.vars.example` to `.dev.vars`. Set AUTH_BASE_URL to the exact loopback origin. AUTH_ALLOW_LOCAL_HTTP=true only permits localhost/127.0.0.1/::1. Deployed origins require HTTPS.

Production setup:

1. Create fresh D1 and R2 resources and fill in binding identifiers. The separate private bucket arrives in step 3.
2. Set AUTH_BASE_URL to the final HTTPS origin; leave AUTH_ALLOW_LOCAL_HTTP=false.
3. Generate a cryptographically random BETTER_AUTH_SECRET of at least 32 characters; store it with `wrangler secret put BETTER_AUTH_SECRET`. Never use the example secret.
4. Verify a Resend sender domain and set RESEND_API_KEY and AUTH_EMAIL_FROM.
5. Create Google OAuth Web credentials with callback `https://YOUR_DOMAIN/api/auth/callback/google` and a loopback callback for development; set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
6. REVIEWER_EMAIL is transitional behavior until roles/MFA replace it. Do not collect real verification evidence at this checkpoint.
7. Build, migrate and finish all six approvals before activating a public route.

## Password CPU release gate

The target Cloudflare plan and effective CPU setting have not been confirmed. Bcryptjs cost 12 was therefore not selected; Better Auth's standard scrypt remains enabled.

`npm run test:auth` measures local workerd hash+verify round-trip latency. This verifies runtime compatibility, NOT deployed CPU consumption or Free-plan suitability. Before activation, confirm the plan/cap, exercise signup/sign-in/reset on protected staging, and record p50/p95/p99 CPU time from Workers metrics. If hashing exceeds the cap, resolve the deployment limit rather than weakening the hash.

Live Google consent/callback, Resend delivery and deployed CPU checks require configured external services. Test doubles do not establish those checks.

## Requirements retained for later steps

- Applicants must be at least 18.
- Admin-only private identity bucket, no r2.dev/custom domain, no seller document retrieval or private-field responses.
- Sanitize ALL uploads server-side to remove EXIF/GPS metadata before storage/publication.
- Required unchecked location consent explains public place label/pin/photo and recommends nearby pickup points for home cooks.
- Separate optional unchecked portrait consent permits only a sanitized public copy. Withdrawal blocks access immediately and deletes that copy. The passport original remains private; NID photos never become public.
- Retention enabled, 30 days by default: delete approved NID photos; retain approved passport, encrypted NID, approval record and structured fields until account deletion. Delete all rejected-submission documents 30 days after rejection. Resubmission does not extend earlier deadlines.
- Account deletion revokes access and deletes all files, derivatives and sensitive records; retain only minimal audit events. Retry failures and do not claim completion until finished.
- Mandatory admin TOTP, including Google sessions; buyer-only seller-level interest/reviews with database uniqueness; reporting and suspension.

## Validation

Step-1 results:

- Eight integration tests pass in local workerd/D1: verified sessions, email/reset expiry and replay, logout/reset revocation, generic account responses, spoofed headers, CSRF, concurrent rate limiting, OAuth initiation/state rejection, concurrent verification, expired sessions, HTTPS enforcement and oversized requests.
- Local scrypt hash+verify round trips: 130–136 ms in the final integration run. This is latency, not deployed CPU time.
- TypeScript and lint on the new authentication files pass. Full-project lint remains blocked by existing issues in the legacy food/verification code; generated workerd bundles are excluded.
- Production build passes. Local migrations 0000–0004 applied successfully.
- Built-app HTTP smoke checks pass for all six account pages, the anonymous seller redirect, removed ChatGPT route and homepage links.
- Visual/interactive browser checks are pending because no browser is connected. Real Resend delivery, Google OAuth completion and deployed CPU/plan validation are pending external configuration.
- No deployment or remote migration was performed. Steps 2–6 have not started; their acceptance tests are not claimed complete.
