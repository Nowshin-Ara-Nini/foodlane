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

## Verification

TypeScript, full ESLint and production build passed. The application/security suite passed 68 tests; the compiled Worker Google/admin MFA test passed 1; Chromium account/moderation interactions passed 1. All reported zero failures. Chromium uses production components with simulated API responses; server authorization is covered separately.

`pnpm audit --prod` reported zero known advisories at this check. Failure injection confirmed that provider deletion and D1 transaction failures preserve disabled accounts and durable jobs, then finish on retry.

Evidence is saved in ignored `.wrangler/release-checks`. No real accounts were banned/deleted. No production admin role, migration or deployment was changed.

## Still required before public launch

1. Review/apply production migrations 0010-0013 with the appropriate backup/recovery checkpoint.
2. Confirm production server secrets, Google callback/provider settings and intended remote admin role; complete MFA. Secret configuration was not inspected.
3. Deploy the reviewed build/configuration, then verify public URL health, Images/R2 bindings, private document access, cron and operational alerts.
4. Run the full deployed synthetic seller submission, review/approval, listing, buyer engagement and moderation/deletion journey, including cleanup failure/recovery. Local synthetic tests do not establish live Google or production configuration.
5. Preserve a reviewed release snapshot of intended source/migrations/lockfile, excluding local secrets and runtime files.

Local remediation is verified. Production readiness remains conditional on those checks. See [ADMIN_ACCOUNTS_RUNBOOK.md](ADMIN_ACCOUNTS_RUNBOOK.md) for administrator instructions.
