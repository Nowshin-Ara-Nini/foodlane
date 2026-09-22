# Foodlane final security checkpoint

All six implementation steps are complete locally. Step 6 awaits owner review. **Public activation is not authorized yet:** live-provider, remote-storage, browser and deployed CPU checks below remain outstanding. No remote migration or deployment was run.

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

0000–0009 are applied to local test D1. A fresh database must apply them all in order:

```sh
npm run db:migrate:local
# Only against the configured fresh remote test database at the deployment gate:
npm run db:migrate:remote
```

Configure direct Cloudflare deployment in `wrangler.jsonc`. Replace the placeholder database ID with the intended fresh database. Bind `DB`, `BUCKET`, `PRIVATE_VERIFICATIONS` and `IMAGES`. Both R2 buckets must have r2.dev access and custom domains disabled: all media, including public portraits, passes through Worker authorization/consent routes. Do not attach an R2 public domain, lifecycle rule or cache rule that bypasses these routes or erases retained passports. Configure the daily cron.

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

Final local results: **53 tests passed** (52 source/integration/render tests plus one compiled-Worker journey), TypeScript passed, full-project lint passed with no errors or warnings, and the production build passed. Migration 0009 applied successfully. The built scheduler ran against local D1/R2 with `scheduled: ok` and zero pending jobs at that check. A regression test also covers account deletion changing a file job while cleanup is in flight, ensuring the successful delete leaves no stale job record.

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
```

## Outstanding release gates

1. **Browser journeys:** no browser is connected to the available automation tool. HTTP rendering tests are not interactive browser tests. Check desktop/mobile maps, tile attribution, geolocation allow/deny, pin selection, buyer review/report, seller submission, MFA review/moderation and account deletion.
2. **Live auth/email:** configure and test Google OAuth plus Resend verification, password-reset and deletion-code delivery. Local tests use a mail test double and do not establish external delivery.
3. **Workers CPU:** confirm the Cloudflare plan and effective CPU cap; benchmark standard Better Auth scrypt on protected deployed staging and record CPU p50/p95/p99. Local workerd latency proves compatibility only. Bcrypt cost 12 was not selected without runtime evidence; do not weaken scrypt to fit an unconfirmed Free-plan cap.
4. **Private infrastructure:** inspect both remote buckets for disabled r2.dev/custom domains; attempt anonymous retrieval of a test document; verify Images binding and cron; test deliberate R2 failures and monitor retries. Run migrations on fresh test resources, never cut over old sensitive data casually.
5. **Recovery/backups:** determine D1/provider recovery retention and restrict operators. Before restoring service from any backup, reapply account deletions using minimal opaque audit references and rerun file cleanup. Audit/account-delete markers must not be rolled back with a restore. Do not describe active-storage deletion as immediate erasure from provider-managed backups.
6. **Final owner approval:** review this checkpoint and approve deployment only after these checks pass. `workers_dev=false`, `preview_urls=false`, and the placeholder DB ID remain in place. No public replacement has been activated.

Provider references: [Better Auth account deletion and reauthentication](https://better-auth.com/docs/concepts/users-accounts), [Cloudflare Workers logging controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
