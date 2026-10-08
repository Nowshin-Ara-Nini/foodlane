# Foodlane final security checkpoint

All six implementation steps are implemented locally. The owner has requested completion of Step 6 and the remaining release checks. Public activation remains gated on the checks below. The fresh remote D1 schema is now migrated; the application Worker has not been deployed.

## Current infrastructure status (2026-10-03)

Cloudflare authentication and R2 activation are confirmed. The configured buckets are `foodlane-4589103-bd-media` (`BUCKET`) and `foodlane-private-12405-verifications` (`PRIVATE_VERIFICATIONS`). Read-only Cloudflare checks confirmed r2.dev access disabled and no custom domains on either bucket. This establishes bucket settings, not a deployed document-route or image-processing test. The target Workers plan is Free. A protected synthetic probe tested Better Auth scrypt on the deployed Workers runtime: hash creation passed 25/25 requests; verification passed 12/25 and then returned CPU resource-limit failures on 13/25. Wall time was recorded, but Cloudflare CPU-time metrics were not available. Standard scrypt is therefore not reliable on this Free runtime and blocks public account activation. A fresh empty APAC D1 database named `foodlane` is configured, and migrations 0000–0009 are applied. The account workers.dev subdomain `nowshinaranini.workers.dev` is registered. The application origin remains `https://foodlane.invalid` and `workers_dev=false`. The local `.dev.vars` file has an NID key ring but no Resend or Google OAuth credentials; its sender address is still a placeholder. No secret values were displayed.

## Step 6 behavior

- Buyers can report an approved seller from `/sellers/[id]`. Reasons are private to MFA-verified admins. Only one open report per buyer/seller is allowed; repeat submission returns 409. The database enforces uniqueness.
- `/admin` lists paginated reports and suspensions. Admins dismiss reports or suspend sellers with a reason. Decisions use an atomic conditional update; competing decisions return 409. Detail views and decisions create minimal audit events without report text or file references.
- A separate `seller_suspensions` record blocks discovery, seller/media APIs and seller mutations even if a stale approval changes the profile status. Sellers see the reason in their dashboard. They can still withdraw portrait consent and delete their account. Lifting a suspension leaves the profile pending and requires renewed verification before publication.
- `/account` requests an email deletion code, then requires that code and the literal `DELETE`. The 128-bit random code expires in 10 minutes, is stored as a keyed digest, belongs to the requesting user/session, and is atomically consumed once. This reauthenticates control of the verified email for password and Google users. Admins additionally require session MFA. A new code invalidates the earlier code for that session.
- Account deletion immediately revokes sessions and deletes account/profile, verification fields, MFA material, reports and engagement. Every managed file and legacy food image is queued. Successful object deletion removes its job/key; failures retry. 200 means no file jobs remain; 202 explicitly says file cleanup remains pending. In-flight uploads have a bounded staging window and cannot publish late writes after deletion. Minimal audit subjects use opaque seller/user IDs, never contact details or free-text notes.
- `/privacy` describes collected data, private verification, public location and optional portrait consent, metadata sanitization, processors, retention, backups/recovery and deletion. The operator-approved public contact is **nowshinaranini@gmail.com**, configured in `lib/site-config.ts`.

## Request protection and logs

| Limit | Persistent policy |
| --- | --- |
| Application API | 300 requests/IP/minute; authenticated reads 240/user/minute; writes 60/user/minute |
| Verification/food uploads | 10/user/10 minutes, shared across both upload paths |
| Buyer reports | 3 attempts/user/24 hours |
| Deletion email | 3/user/15 minutes |
| Deletion confirmation | 5 attempts/user/15 minutes |
| Admin MFA | Existing 5 mutations/user/10 minutes |
| Authentication | Existing IP/endpoint/email limits in `lib/auth-handler.ts` |

Counters are atomic D1 upserts, shared across isolates. IP/email and general API account keys are HMACs. Cloudflare must remain the ingress that overwrites `CF-Connecting-IP`; do not expose the Worker behind an untrusted header-forwarding proxy. Local development uses a shared fallback if that header is absent. The limits include failed attempts and return 429 with retry guidance.

JSON bodies are streamed with a 16 KiB limit. Upload envelopes are bounded at 6 MiB for one food image and 16 MiB for verification, with individual JPEG/PNG files limited to 5 MiB and decoded dimensions capped. Application API paths/query inputs are bounded and validated; unknown/duplicate query parameters fail. Same-origin POST and `Sec-Fetch-Site` checks defend cookie-authenticated mutations. Better Auth protects OAuth state and callbacks. Retired APIs have ingress limits and never serve legacy data.

The Worker refuses non-HTTPS requests except explicitly enabled localhost/127.0.0.1/::1 development. Deployed HTTPS responses have HSTS, nosniff, frame denial, restricted object/base/form policies and permissions policy. Private pages and APIs use no-store and no-referrer. Existing stronger document CSP is preserved. Leaflet tile images send only the origin referrer to satisfy tile policy without exposing a private page path.

No passwords, codes, tokens, NID values, file keys or request bodies are written to application logs. Generic event codes are used. `observability.enabled=false` disables automatic Workers URL/header logs and traces during this rollout. Before enabling any telemetry/Logpush/tail consumer, configure redaction for auth callback/reset/verification URLs and private route references. Cloudflare/provider operational records are separate from application audit records.

The 03:00 UTC daily cron deletes expired sessions, verification/reset records, email-link digests, deletion challenges, counters and unused MFA setup/proofs, then processes up to 2,000 file jobs per run. Failures/backlogs remain durable for later runs. Monitor pending-job counts without selecting or logging keys. Use `npm run verification:cleanup:local` to dispatch the built Worker scheduler against local data; this avoids the pinned Wrangler preview scheduled-event forwarding issue.

## Migrations and configuration

Migration history is append-only:

| Migration | Purpose |
| --- | --- |
| `0000`–`0003` | Existing application history |
| `0004_auth_roles` | Better Auth accounts, sessions, verification and rate-limit records |
| `0005_role_permissions` | Roles/ownership and fresh-test cutover support |
| `0006_private_verification` | Separate encrypted verification, consent, managed files, audit and retention |
| `0007_admin_mfa` | Encrypted TOTP material, session proofs, recovery digests |
| `0008_seller_engagement` | Seller-level interest/reviews and discovery indexes; merges legacy dish engagement |
| `0009_abuse_deletion` | Reports, independent suspensions and session-bound deletion challenges |

Migrations 0000–0009 are applied to the local test D1 and to the fresh remote APAC D1 database named `foodlane` (ID `b614e824-94ac-4b70-b2b2-a09fa442115c`). Wrangler reports no migrations pending remotely. The database is empty apart from schema/history. For another fresh database, apply them in order:

```sh
npm run db:migrate:local
# Only against the configured fresh remote D1 database:
npm run db:migrate:remote
```

Direct Cloudflare deployment is configured in `wrangler.jsonc` for the fresh `foodlane` D1 and the two verified private R2 buckets. Bind `DB`, `BUCKET`, `PRIVATE_VERIFICATIONS` and `IMAGES`. Both R2 buckets must have r2.dev access and custom domains disabled: all media, including public portraits, passes through Worker authorization/consent routes. Do not attach an R2 public domain, lifecycle rule or cache rule that bypasses these routes or erases retained passports. Configure the daily cron.

Secrets and variables:

- `AUTH_BASE_URL`: exact final HTTPS origin; `AUTH_ALLOW_LOCAL_HTTP=false` in deployment.
- `BETTER_AUTH_SECRET`: generated secret, at least 32 characters, stored with Wrangler secrets.
- `RESEND_API_KEY` and verified `AUTH_EMAIL_FROM`: verification, reset and deletion-code delivery.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: OAuth Web client, callback `https://YOUR_DOMAIN/api/auth/callback/google`.
- `NID_ENCRYPTION_KEYS`: secret JSON key ring of base64 32-byte AES keys; `NID_KEY_VERSION` selects the active key. Retain older keys while ciphertext still uses them.
- `VERIFICATION_RETENTION_ENABLED=true`, `VERIFICATION_RETENTION_DAYS=30`: rollout defaults. Changing retention configuration does not rewrite existing job deadlines. Any policy/configuration change needs a privacy-policy review. Account deletion overrides retention.

Never commit `.dev.vars`, export provider credentials into frontend code or use the development example keys remotely. See [PRIVATE_DATA_RUNBOOK.md](PRIVATE_DATA_RUNBOOK.md) for private bucket provisioning/key procedures and [ADMIN_RUNBOOK.md](ADMIN_RUNBOOK.md) for initial admin provisioning and recovery handling.

Initial admin:

```sh
# Create and verify an account first, then use its opaque user ID:
node scripts/provision-admin.mjs --local VERIFIED_USER_ID
# Remote only for the intended deployment:
node scripts/provision-admin.mjs --remote VERIFIED_USER_ID
```

Provisioning revokes existing sessions. Sign in again, enroll TOTP at `/admin/mfa` and save the one-time recovery codes securely. Do not promote users by matching a public email header or client-selected role.

## Acceptance evidence

Revalidated on 2026-10-03: **54 tests passed** (52 source/integration/render tests, one compiled-Worker journey and one Chromium component journey), TypeScript and the production build passed. Full-project lint found no errors and one anonymous-export warning in the benchmark helper; that warning was fixed and the helper/new browser test were linted separately. Local migrations report no pending changes through 0009. The built scheduler returned `scheduled: ok` with zero pending jobs. A regression test also covers account deletion changing a file job while cleanup is in flight, ensuring the successful delete leaves no stale job record. The first Chromium attempt exceeded its overall startup timeout; the rerun with a longer allowance passed.

Automated local acceptance covers:

- Anonymous/buyer/seller admin-document requests return 403; admins without session MFA are rejected.
- Private document keys are absent from public/seller projections and cannot be retrieved through public routes or the media bucket. Actual remote bucket URL privacy still requires the deployment check below.
- Pending, rejected and suspended sellers are excluded from listings, profiles and public media. A stale approval cannot bypass a suspension.
- Concurrent interest creates one row; concurrent review creation produces one success and 409 duplicates. Editing is owner-scoped.
- Under-18 applicants and absent location consent fail before storage. Portrait consent is independent; withdrawal blocks the public route and projection.
- Uploaded/stored/published images lack EXIF/GPS and other ancillary metadata; all eight EXIF orientations preserve the visible pixels.
- Approval/rejection retention uses the correct decision timestamp; resubmission does not extend older deadlines.
- Reauthenticated account deletion rejects wrong user/session, expired/replayed codes and CSRF; Google-style accounts and MFA admins follow the same email proof. Failed R2 deletions return pending work and succeed on retry; private/public derivatives and sensitive records disappear.
- Persistent auth/API/upload/deletion/report limits and malformed/oversized input fail closed.
- Built Worker HTTP journeys cover public pages, privacy contact, protected account/admin pages, MFA enrollment/recovery/logout, HTTPS/security headers and scheduled expiry cleanup.

Validation commands:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:built
npm run test:safety:browser
```

The Step 6 browser suite uses real Chromium with the production account/moderation components and simulated API responses. It checks deletion error recovery, accurate pending-cleanup messaging and moderation conflicts. It does not replace integrated browser journeys, live email delivery or deployed authorization checks. Install its browser once using `npx playwright install chromium --only-shell`, with `PLAYWRIGHT_BROWSERS_PATH` set to `.wrangler/pw-browsers` (or another explicitly configured path).

## Outstanding release gates

1. **Integrated browser journeys:** Chromium is installed for isolated local checks. Still check the full application on desktop/mobile: maps, tile attribution, geolocation allow/deny, pin selection, buyer review/report, seller submission, MFA review/moderation and account deletion. Component tests with simulated APIs do not establish these end-to-end journeys.
2. **Live auth:** verify the Google OAuth provider and exact callback URL after deployment. Supabase SMTP is not used for sign-in; separately confirm the account-deletion email delivery route if enabling account deletion.
3. **Workers CPU:** the owner confirmed the Free plan. The protected deployed synthetic benchmark recorded 25/25 successful scrypt hash creations, but only 12/25 successful verifications; 13 verification requests hit CPU resource limits. Wall time is not CPU time, and p50/p95/p99 CPU metrics remain unavailable. Standard scrypt does not reliably fit this Free runtime. Keep the secure default and do not activate public authentication on this configuration; resolve the runtime/plan choice before release. Bcrypt cost 12 was not selected.
4. **Private infrastructure:** both remote buckets have passed r2.dev/custom-domain configuration checks. Still attempt anonymous retrieval of a synthetic test document; verify deployed Images binding and cron; test deliberate R2 failures and monitor retries. The fresh remote database migration is complete; no real seller or verification data has been cut over.
5. **Recovery/backups:** determine D1/provider recovery retention and restrict operators. Before restoring service from any backup, reapply account deletions using minimal opaque audit references and rerun file cleanup. Audit/account-delete markers must not be rolled back with a restore. Do not describe active-storage deletion as immediate erasure from provider-managed backups.
6. **Final owner approval:** review this checkpoint and approve deployment only after these checks pass. `workers_dev=false` and `preview_urls=false` remain in place. The configured D1 has the empty fresh schema. No public replacement has been activated.

Provider references: [Better Auth account deletion and reauthentication](https://better-auth.com/docs/concepts/users-accounts), [Cloudflare Workers logging controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Supabase Auth cutover

The active auth API uses Google OAuth as its only sign-in method. Foodlane issues an opaque HttpOnly `foodlane_session` cookie and keeps provider access/refresh tokens in D1. New Google users choose a Foodlane display name, whether to show their Google profile photo, and a one-time buyer or seller role. Password and email-verification endpoints are disabled in the app; Supabase SMTP is not part of sign-in.

Migration `0010_supabase_auth.sql` adds nullable provider-token columns to `auth_sessions`. The migration is included in Drizzle metadata. Focused Supabase OAuth tests, all 38 role/security integration tests, TypeScript checks, and the auth smoke checks pass locally. The migration has not been applied remotely, and this Google-only auth update has not been deployed.

The server-only `SUPABASE_SECRET_KEY` is required for account deletion; the endpoint fails closed without it so deletion cannot leave an active Supabase identity behind. Follow [SUPABASE_AUTH_RUNBOOK.md](SUPABASE_AUTH_RUNBOOK.md) for dashboard provider setup, callback URLs, and secrets. Before release, disable the Supabase Email provider, apply the remote migration, and verify the Google callback and account deletion in the deployed Worker.
## October 8 account moderation and recovery update

Current local implementation supersedes the older email-deletion and password-runtime release notes above: Google is the only sign-in method. Account deletion uses durable cross-provider retry jobs; no confirmation email is used. Buyer/seller bans revoke Foodlane sessions and prevent sign-in. Admin account controls and cleanup health are documented in [ADMIN_ACCOUNTS_RUNBOOK.md](ADMIN_ACCOUNTS_RUNBOOK.md). Production migrations 0010�0013 and deployed provider/binding/cron smoke checks remain release gates. Password hashing CPU results above concern the retired application sign-in path.
