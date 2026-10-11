# Foodlane upgrade

## Approval checkpoints

Implement one step at a time. After each, report changes, checks, limitations and migrations, then wait for explicit owner approval. Do not activate the replacement publicly until all six checkpoints and deployment checks pass.

1. Authentication: implemented locally; approved to proceed to step 2.
2. Server-side roles and adult seller eligibility: implemented; approved to proceed to step 3.
3. Private verification, consent, image sanitization and retention: implemented locally; approved to proceed to step 4.
4. Admin review, mandatory MFA and audit panel: implemented locally; approved to proceed to step 5.
5. Maps, near-me, seller-level interest/reviews: implemented locally; approved to proceed to step 6.
6. Abuse protection, account deletion and privacy policy: implemented and locally revalidated on 2026-10-03 at the owner's request; deployment checks remain outstanding.

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

`drizzle/0004_auth_roles.sql` adds auth users, accounts, sessions, verification tokens, rate-limit counters and verification-link digests. Role fields are added by `0005_role_permissions.sql`; MFA fields remain deferred to step 4. Applied migrations are never rewritten.

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
6. Provision admins by verified account ID using the operator command below. REVIEWER_EMAIL is no longer supported. Do not collect real verification evidence before the private-storage and MFA steps.
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
- Verification review immediately erases NID ciphertext and verification-only details; legal name and personal contact fields remain until account deletion. Private originals are queued for deletion, with retries and restore-time scrubbing.
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
- No deployment or remote migration was performed in step 1; later-step acceptance was not claimed complete.

## Step 2: roles, permissions and eligibility

Every active application API resolves a verified D1 session and reads the current account role from D1. The API never trusts role headers, submitted user IDs, or cookie-cached roles. Cross-role requests return 403 before private queries, body parsing, or storage access.

- Email signup offers buyer/seller selection. Admin is never a public signup option; role/roleChosen mass-assignment fields are rejected.
- New Google users complete a one-time role choice after identity verification, bound to their authenticated session. Until that choice is saved, buyer/seller/admin operations are denied. A conditional D1 update prevents concurrent choices or later role switching.
- Existing step-1 accounts are backfilled to seller if they own a seller profile, otherwise buyer. Existing unverified sellers become pending. New profiles start pending and remain hidden.
- Seller profile/food changes and photo access derive ownership from the current session. Submitted ownership/status fields are rejected; another seller's food ID returns 403.
- Only buyers may use interest/review routes. These remain per-food in this checkpoint; step 5 changes their uniqueness to per-seller.
- Only admins can access pending verification details, documents and decisions. Document owners are denied alongside all other sellers. Document routes take submission ID/kind rather than storage keys and use private, no-store responses.
- Public catalogue and seller dashboard use explicit projections. Personal contact details, NID/home data and stored document keys are excluded. Seller submissions expose status/timestamps/rejection reason only. Public serving-location text is named place_label, distinct from home_address.
- Age must be a whole number between 18 and 120, checked in the browser and server before image bytes are processed/stored. Approval requires the reviewer to explicitly confirm adult eligibility. Submitted age below 18 or evidence marked underage forces rejection; an adult checkbox cannot override an underage submitted age.
- `/seller`, `/review` and `/admin` are server-guarded. Wrong-role accounts redirect to `/forbidden` without receiving protected content. `/admin` temporarily redirects authorized admins to the existing review desk; the full panel/MFA arrives in step 4.

### API contracts

| Routes | Access |
|---|---|
| GET `/api/public/catalogue`, `/api/public/photos/{foodId}` | Public; approved sellers and available food only |
| GET `/api/account/me`, POST `/api/account/role` | Verified account; role choice allowed once |
| GET `/api/buyer/interests`, POST `/api/buyer/interest`, `/api/buyer/review` | Buyer only |
| GET `/api/seller/dashboard`, POST `/api/seller/profile`, `/api/seller/food`, `/api/seller/verification`, `/api/seller/photos` | Seller only; writes scoped to own data |
| GET `/api/seller/photos/{uploadId}` | Owning seller only |
| GET `/api/admin/verifications`, `/api/admin/verifications/{id}/documents/{kind}`, POST `/api/admin/decision` | Admin only; kinds: identity, passport, selling |

Legacy `/api/data`, `/api/action` and `/api/photo` return 410. Legacy `/api/evidence` returns 403 to non-admins and 410 to admins. The client now uses the separate routes. JSON mutations require same origin and strict validation; upload bodies have enforced byte limits.

### Migration and admin provisioning

`drizzle/0005_role_permissions.sql` adds roles and one-time onboarding state, updates the seller default/backfill to pending, and preserves existing seller/food foreign-key relationships. It has been applied locally. Production remains untouched.

```sh
npm run db:migrate:local
# After configuring the intended database:
npm run db:migrate:remote

# Use the ID of an existing, email-verified account:
npm run admin:provision -- --local VERIFIED_USER_ID
# Operator-controlled production equivalent:
npm run admin:provision -- --remote VERIFIED_USER_ID
```

Provisioning validates the ID, promotes only verified accounts, revokes existing sessions, and requires another sign-in. It does not create accounts or verify email on someone's behalf. No admin account was provisioned outside disposable test data.

### Checks and limits

- All 18 auth/role integration tests pass in local workerd with D1/R2, including ownership, role spoofing, stale sessions, all non-admin document denials, underage rejection before storage, private response projections, existing-data migration, one-time onboarding and verified-only admin provisioning.
- TypeScript and production build pass. New server/auth/role modules have no lint errors. Legacy Foodlane/verification UI still has lint findings.
- Built-app HTTP smoke checks pass: anonymous protected APIs return 403, retired endpoints return 410, public catalogue returns 200, protected pages redirect to login, and all six account screens still render. Full-project lint currently reports 23 legacy UI errors and 8 warnings; no new server-module lint errors.
- Storage is still the pre-existing shared bucket and the legacy verification table still stores NID plaintext. Private R2 separation, encryption, sanitization, retention and full auditing require step 3. MFA requires step 4. Reports and account deletion require step 6. This checkpoint is not authorization to deploy or collect real identity documents.
- Google OAuth completion, real email delivery, deployed CPU validation and interactive browser checks remain pending external configuration/browser availability.
- Next implementation step requires explicit owner approval. Future migrations will continue after 0005 rather than reuse applied numbers.


## Step 3 checkpoint

Private verification, AES-256-GCM encryption, private R2 binding, all-image sanitization, independent consent, audited access and daily retryable retention are implemented. See [PRIVATE_DATA_RUNBOOK.md](PRIVATE_DATA_RUNBOOK.md) for changes, checks, remaining deployment limitations and exact configuration commands.

New migration: `0006_private_verification.sql` (applied locally). It follows the already-applied `0005_role_permissions`; future engagement work must use 0007 or later. The approved fresh-data cutover drops legacy plaintext verification tables after queueing their files for deletion, resets legacy seller approval and disables unsanitized legacy food images. No remote migration or deployment was performed.

30 tests, TypeScript, production build, built HTTP smoke checks and direct dispatch of the built scheduled handler pass. Existing whole-project lint issues remain; newly added server modules/scripts/tests are clean. Production bucket privacy, deployed Images/CPU/cron behavior and interactive browser journeys remain to be checked. Mandatory admin MFA and its denial tests belong to step 4. Account deletion's internal cleanup primitive is tested; the reauthenticated user endpoint belongs to step 6.

Step 4 has not started. Wait for explicit owner approval.


## Step 4 checkpoint

`/admin` now contains the review desk and paginated minimal audit history; `/review` redirects there. Mandatory TOTP enrollment and session-bound MFA apply to every admin data route, including document access and Google-origin sessions. Recovery codes are one-time and hashed. Admin pages and responses are non-cacheable. The seller dashboard supports requesting renewed review for place-photo changes.

Migration `0007_admin_mfa.sql` was applied locally; the audit table remains from 0006. No remote migration or deployment occurred. 43 tests, TypeScript, production build and targeted lint pass. Built HTTP journeys cover enrollment, admin access, logout and recovery. Existing full-project lint failures and unavailable interactive browser/live-provider checks are documented in [ADMIN_RUNBOOK.md](ADMIN_RUNBOOK.md).

Step 5 has not started. Stop and wait for explicit owner approval.


## Step 5 checkpoint

Leaflet/OpenStreetMap replaces embedded Google maps. Sellers select a draggable pin in profile and verification forms. `/map` supports geolocation or manual point selection, approved-seller markers, a default 5 km radius (maximum 100 km), exact distance ordering and pagination. `/sellers/[id]` shows the public place/photo, consented portrait, available foods, seller rating, and buyer interest/review controls.

Engagement belongs to sellers rather than dishes. Database primary keys prevent duplicate buyer/seller pairs. Interest is idempotent; review creation returns 409 on a duplicate; `/api/buyer/review/edit` updates only the caller's review. Dashboard totals count distinct interested buyers. Existing account cleanup cascades through the new engagement records.

Migration `0008_seller_engagement.sql` adds engagement tables/constraints and discovery indexes, merges legacy food interests, and keeps each buyer's latest food review per seller. It clears retired food engagement rows after transfer. Migration history 0000-0007 is unchanged. Applied locally only.

Checks and pending manual/deployment work are documented in [DISCOVERY_RUNBOOK.md](DISCOVERY_RUNBOOK.md). Step 5 was subsequently approved. See the step 6 checkpoint below.


## Step 6 checkpoint

Buyer abuse reports and MFA-protected admin dismissal, suspension and lifting workflows are implemented. Suspensions have an independent record checked by discovery, media and writes. Lifting a suspension requires renewed verification before publication.

Account deletion is available at `/account`. A 128-bit, single-use confirmation code is emailed to the verified address, expires in 10 minutes and is bound to the current session. This supports password and Google accounts; admins also require session MFA. Deletion revokes access, removes structured data and cascades through engagement/reports, then processes retryable file jobs. A 202 response explicitly reports remaining file work.

Persistent API, upload, report and deletion limits, bounded inputs, exact-origin CSRF checks, HTTPS/security headers, scheduled expiry cleanup and generic operational logging are in place. `/privacy` publishes the owner-provided contact `nowshinaranini@gmail.com`, collected data, public/optional consent, processors, retention and deletion details. Legacy UI typing/lint problems were fixed without changing the design.

`0009_abuse_deletion.sql` adds report, suspension and deletion-challenge tables; applied locally and to the fresh remote D1 schema. See [SECURITY_RUNBOOK.md](SECURITY_RUNBOOK.md) for full migrations, checks, acceptance results and remaining deployment gates. All six steps are implemented locally; a fresh remote D1 schema is migrated, and no public application activation has occurred. Remaining deployment gates are in SECURITY_RUNBOOK.md.

Latest local checks (2026-10-03): 54 tests pass (52 source/integration/render, one compiled-Worker journey, one Chromium component journey), TypeScript and production build pass, local migrations are current through 0009, and scheduled cleanup succeeds with zero pending jobs. The full lint run found one warning in the benchmark helper; it was corrected and the changed helper/browser test linted separately. Chromium covers Step 6 deletion error recovery/pending cleanup and moderation conflicts with simulated APIs. Full integrated browser journeys, live Google/Resend, and deployed image/cron behavior remain release gates. A protected deployed probe showed default scrypt hash creation passing 25/25 samples but verification passing only 12/25 before 13 CPU resource-limit errors; public auth activation is blocked on the Free plan unless the runtime constraint is resolved. Both real R2 buckets now have disabled r2.dev access and no custom domains, verified through Cloudflare; their actual names are configured in wrangler.jsonc. The fresh remote D1 schema is applied and `nowshinaranini.workers.dev` is registered, but the application origin remains a placeholder and public activation remains disabled.

> **Current auth behavior (October 2026):** The Google-only update below supersedes the earlier Step 1 email/password UI and verification-email details. The app now exposes Google OAuth only, then collects the Foodlane display name, Google profile-photo preference, and one-time buyer/seller choice. New sellers continue through the existing private verification and admin approval flow.
## Supabase Auth cutover (October 2026)

Because the Free-plan scrypt verification probe hit Worker CPU limits, the active `/api/auth` route now uses Supabase Auth. Foodlane keeps API authorization, role mapping, and opaque D1 sessions on Cloudflare. The browser receives only a random HttpOnly cookie; Supabase access and refresh tokens are stored in D1. Password verification runs at the auth provider. Existing Better Auth password identities are not imported; this cutover assumes fresh accounts.

`drizzle/0010_supabase_auth.sql` adds provider-token fields to D1 sessions. The migration is recorded in Drizzle metadata and was syntax-checked in an isolated SQLite database, but it has not been applied remotely. See [SUPABASE_AUTH_RUNBOOK.md](SUPABASE_AUTH_RUNBOOK.md) for dashboard configuration and migration commands.

The user has created a Supabase project and added the URL and publishable key locally using the `NEXT_PUBLIC_SUPABASE_*` names; the adapter accepts those names server-side. Google provider credentials and callback allow-list configuration are required; Supabase email verification and SMTP are no longer part of sign-in. A Supabase server-only secret key is required for account deletion; that endpoint fails closed without it. The app origin is `https://foodlane.nowshinaranini.workers.dev`.

### Customer feedback and recommendations
Dish details and public shop pages share the customer feedback panel. Signed-in buyers can publish or edit one review per seller, and separately add or remove one recommendation per seller. Recommendations do not create interest or alter ratings. Guests can read feedback; sample listings show the controls with publishing disabled.
“Neighbors love these” ranks real shops by recommendation count; “On everyone’s mind” ranks by distinct interested customers. Sellers with no corresponding signal are excluded. These are per-seller counts shared across dishes.
Migration 0012_spotty_alex_power.sql adds seller_recommendations with a unique seller/customer pair and cascading account/seller cleanup. Applied to the local database only; apply migrations before deploying this version.
New buyer routes: GET /api/buyer/feedback/:sellerId returns the caller’s review and recommendation; POST /api/buyer/recommendation accepts {sellerId,recommended}. Verified status, suspension, role, ownership and same-origin checks apply. Public catalogue and seller projections return recommendation_count.

### Address search on Explore map
Explore map now uses Google Maps with road/landmark, neighborhood, city and district fields instead of visible coordinates. Named searches match published seller addresses; Near me retains internal distance calculations. Each result can be selected on the map or opened in Google Maps directions. Seller verification/pin-editing maps retain their existing separate workflow. No new database migration or Maps Platform billing setup was needed.
