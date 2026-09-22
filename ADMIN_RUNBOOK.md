# Step 4: admin review and MFA

Step 4 is implemented locally. Public deployment remains disabled. Step 5 requires explicit owner approval.

## Migration and provisioning

New additive migration: `drizzle/0007_admin_mfa.sql`. Earlier migrations, including the step 3 audit table in 0006, are unchanged. It adds encrypted MFA factors, session proofs and hashed recovery codes with account/session deletion cascades. Existing admin sessions have no MFA proof and lose admin access until enrollment/verification.

```powershell
npm.cmd run db:migrate:local
# Only against the intended fresh remote database after deployment approval:
npm.cmd run db:migrate:remote
```

The local migration has been applied. No remote migration or deployment was performed. Future migrations must start at 0008; do not reuse the original plan's already-consumed numbers.

Use the existing verified-account provisioning CLI:

```powershell
npm.cmd run admin:provision -- --local USER_ID
# Operator-only, when remote administration is authorized:
npm.cmd run admin:provision -- --remote USER_ID
```

Provisioning revokes existing sessions. Sign in again, visit `/admin`, and complete `/admin/mfa`. No new secret is required: MFA seeds use Better Auth's authenticated symmetric encryption with `BETTER_AUTH_SECRET`, including their owner ID in the encrypted payload. Keep this secret stable and protect it as carefully as the NID encryption key. Changing it without a migration invalidates existing encrypted MFA seeds as well as authentication signatures.

## Admin journey

1. Sign in using verified email/password or Google. Both providers require the same Foodlane MFA check.
2. First enrollment requires a login session created within ten minutes. Add the displayed setup key to an authenticator app, or open its `otpauth` link. Use six-digit time-based codes with a 30-second interval. Setup expires after ten minutes and belongs only to the session that created it.
3. Enter an authenticator code to activate enrollment. Save the ten recovery codes in a password manager; they are shown once and never stored in localStorage. Only hashes of recovery codes are stored server-side.
4. Review pending applicants at `/admin`. Open their details and protected documents, confirm age eligibility, and approve or reject with a seller-facing reason. Do not put private values in the reason. `/review` redirects to `/admin`.
5. Audit history loads 25 events at a time (API maximum 100) using a validated timestamp/ID cursor. Events retain opaque references, actions and times, without private values, storage keys or free-text notes.

Each MFA proof belongs to one existing Better Auth session and lasts at most eight hours. A different login session, logout, session expiry, password-reset session revocation or account deletion cannot reuse it. There is no trusted-device bypass. A Google provider claim does not substitute for Foodlane MFA. TOTP generation follows [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238); reference-vector tests cover the algorithm, including times beyond 2038.

Codes allow one time step of clock skew either way and are consumed atomically using a monotonic counter. An already-used authenticator code cannot authenticate another session; wait for a new code. Recovery codes grant the current session only and are single-use under concurrent requests. Five MFA mutations per account per ten minutes are allowed across all sessions; enrollment and successful verification also count. Same-origin checks and bounded JSON apply to every mutation.

If the authenticator is unavailable, choose “Use a recovery code.” This does not remove or replace the enrolled factor. There is intentionally no public MFA-disable/reset endpoint. Losing the authenticator and all recovery codes requires operator-assisted identity verification and a controlled database reset, including revoking every session and recovery code. Self-service factor replacement and recovery-code regeneration are not implemented; do not use recovery codes as a permanent replacement for the authenticator.

## Authorization and review guarantees

- All admin data APIs and `/admin` require a verified admin role **and** a live MFA proof. The explicit MFA setup/status/challenge endpoints are the only bootstrap exceptions and still require a verified admin login. Anonymous users, buyers, sellers and admins without MFA receive 403 on admin document routes before file lookup.
- Admin HTML and API responses use `private, no-store`; admin responses also set `no-referrer` and `nosniff`. No seed, code or session credential is put in localStorage or operational logs.
- Successful MFA enrollment, verification and recovery add minimal audit events. Detail/document views and approval/rejection decisions retain the auditing introduced in step 3.
- Decisions, seller approval state, decision audit records and file attachment/deletion deadlines use one conditional D1 batch. Conflicting decisions return 409. Concurrent approvals cannot attach two public derivative sets; losing uploads remain tracked for cleanup.
- Sanitized place photos and consented portraits become available only after approval. Declining portrait consent does not affect approval; withdrawing it blocks portrait access without changing approval.
- Business identity or location edits return approved sellers to pending. Sellers can request a new review to change their place photo or verification details; this immediately hides their seller media. A fresh submission and renewed location confirmation are required before approval restores access.
- Internal account deletion removes MFA factors, hashed codes, session proofs and account-specific MFA rate-limit counters. The reauthenticated user-facing account-deletion flow remains step 6.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run test:admin
npm.cmd test
npm.cmd run build
npm.cmd run test:admin:built
```

The combined run passed **43 tests**: the existing authentication/privacy suite, MFA role/provider matrix, session isolation and expiry, encrypted seed/hashed code storage, replay/expiry checks, concurrent TOTP/recovery consumption, CSRF/rate limits, audit pagination, renewed review, competing decisions and MFA deletion. TOTP reference vectors and React MFA-screen rendering pass. The built-worker HTTP test completes login, enrollment, admin rendering, logout and recovery against disposable D1 resources; it verifies no-store headers and `/review` redirection.

TypeScript, production build and targeted lint for the new/changed server and admin modules pass. Full-project lint still has the existing 23 errors and 8 warnings in the legacy Foodlane, verification and auth UI files. No connected browser was available; interactive browser use, mobile authenticator interoperability and real Google OAuth completion remain external checks. The provider-independent denial is tested with a synthetic Google account/session, not a live Google callback.

The step 3 deployment prerequisites still apply: confirm remote R2 privacy, deployed image handling, runtime CPU limits, live email/Google configuration and actual cron delivery before collecting real documents or publishing. See [PRIVATE_DATA_RUNBOOK.md](PRIVATE_DATA_RUNBOOK.md).


## Final-step update

Step 6 is now implemented locally, including report moderation, reauthenticated account deletion, API limits and privacy policy. Earlier checkpoint statements about pending step 6 work or full-project lint failures are historical. See [SECURITY_RUNBOOK.md](SECURITY_RUNBOOK.md) for current results and deployment blockers.
