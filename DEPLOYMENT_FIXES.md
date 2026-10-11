# Audit remediation - 8 October 2026

## Completed locally

- Added MFA-protected buyer/seller account search, ban, unban and exact-target permanent deletion in `/admin`. Bans revoke sessions, reject future Google sign-in and hide shops. Unbanned sellers require renewed approval. Existing verification approval/rejection and report moderation remain available.
- Made account deletion durable across Supabase and D1 failures. Access is revoked before provider deletion; account/file cleanup jobs survive failures, use bounded leases/backoff and report pending work truthfully.
- Preserved sessions across Supabase refresh/user endpoint 429 and 5xx responses. Invalid credentials still revoke access. Logout removes the local session during provider failures.
- Replaced stale built password-login checks with Google OAuth/session, admin MFA enrollment, protected panel, logout and recovery tests using a synthetic provider.
- Added persisted offer prices/labels and seller editing controls. Catalogue filtering, search and rankings run before bounded database pagination instead of limiting the source to 200 dishes. Added page navigation and global facets.
- Enabled Worker observability and 15-minute cleanup. Scheduled failures reject; admin cleanup health shows pending jobs and timestamps. Production alert configuration remains an operator task.
- Patched production dependency advisories, including Next.js, Sharp and affected transitive packages. Updated privacy and operator documentation.
- Generated migration 0013 and applied it to local D1 only. Added `pnpm verify:release` for repeatable local checks.
- Added migration 0014 for decision-time verification-detail erasure and restore-safe scrub markers. The pending queue no longer contains NID or personal details; detail and document routes require fresh MFA. Privacy and operator guidance now match this retention policy.

## Verification

TypeScript, full ESLint and production build passed. The application/security suite passed 68 tests; the compiled Worker Google/admin MFA test passed 1; Chromium account/moderation interactions passed 1. All reported zero failures. Chromium uses production components with simulated API responses; server authorization is covered separately.

`pnpm audit --prod` reported zero known advisories at this check. Failure injection confirmed that provider deletion and D1 transaction failures preserve disabled accounts and durable jobs, then finish on retry.

Evidence is saved in ignored `.wrangler/release-checks`. No real accounts were banned/deleted. No production admin role, migration or deployment was changed.

## Remaining manual production checks

- Run a synthetic seller submission and admin review using non-real identity data and the active admin MFA session. Production currently has no seller submissions, so approval, post-decision document denial and cleanup retry behavior have not been exercised live.
- Confirm Google OAuth callback and account deletion on the deployed Worker.
- Configure production alerts for scheduled cleanup failures and preserve a reviewed release snapshot without local secrets or runtime files.

See the October 9 rollout record below for completed production steps and verification results. See [ADMIN_ACCOUNTS_RUNBOOK.md](ADMIN_ACCOUNTS_RUNBOOK.md) for administrator instructions.
## October 9 private verification-data hardening and rollout

The user ran `pnpm test:privacy` successfully (48/48). The production build completed; the final wrapper removes the Cloudflare preview `.dev.vars` sidecar after build, and `Test-Path dist/server/.dev.vars` returned false.

Before migration, a production D1 export was saved under the Git-ignored `.wrangler/backups` directory. Production migrations 0010–0013 were already applied; migration 0014 was then applied successfully. A subsequent migration check reported no pending migrations. Aggregate D1 checks returned zero reviewed details awaiting purge, zero private-file deletion jobs pending, and zero seller verification submissions or attached private files.

The latest build was deployed to the existing `foodlane` Worker (version `b79c9aad-8503-41e9-956c-9c4ec3968d9b`). Cloudflare reported D1, both R2 buckets, Images, all five required Worker secret names, and the 15-minute cleanup cron. The named admin account is active with MFA enabled. Live HTTPS checks returned 200 for the homepage/privacy page and 403 for unauthenticated admin verification/document routes. The production synthetic review flow remains untested because there are no seller submissions and it requires an interactive Google/admin MFA session; test it with a synthetic seller before accepting real NID submissions. No NID or real seller test data was created.