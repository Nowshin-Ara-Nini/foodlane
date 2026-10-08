# Foodlane administrator controls

Open `/admin` with a verified administrator account and complete authenticator MFA. Seller identity documents and approval decisions remain in the Verification review desk. Account moderation is in **Buyer & seller accounts** on the same page.

- Search buyers and sellers by name, email or shop name; filter role and account status.
- **Ban account** requires a moderation reason. It revokes all Foodlane sessions, rejects future Google sign-in and hides a seller shop. Use banning when continued access must be blocked.
- **Unban account** restores sign-in, requiring a fresh session. Sellers remain pending until renewed verification is approved. Report-based seller suspensions still need their separate decision.
- **Delete account** requires a reason and the exact `DELETE <account reference>` confirmation. It disables access first, records a durable deletion job, removes the Supabase identity, deletes D1 personal data and queues stored files. Deletion is permanent; it does not prevent a person creating a new identity in the future.
- Administrator accounts and the current administrator cannot be deleted or banned through the buyer/seller controls. Admin provisioning remains an operator action.
- **Deletion & cleanup health** shows outstanding account/file jobs and the latest scheduled run. **Retry due cleanup jobs** respects retry delays and current leases. Automatic cleanup runs every 15 minutes when the reviewed Worker configuration is deployed. Worker logs record generic failure codes and counts; scheduled failures are surfaced as failures. Configure operational alerts in Cloudflare before launch.

All admin account APIs require current D1 administrator role, session MFA and trusted request origin. Decisions are rate limited and audited with minimal opaque references. Ban reasons stay with the account; free-text deletion reasons are not retained in audit logs.

## Release gates

Migration `0013_lucky_domino.sql` is applied locally. Production also needs the previously pending migrations 0010–0012. Review the full migration set, take the appropriate production backup/recovery checkpoint, then run `pnpm db:migrate:remote` as the approved release step. No remote migration or deployment was performed by this change.

Set the server-only `SUPABASE_SECRET_KEY` for provider account deletion. Never expose it to browser code. Verify the deployed Google callback, intended admin provisioning, MFA, Images/R2 bindings and cleanup cron with disposable test accounts before accepting identity documents. Missing provider deletion configuration fails closed.

Run `pnpm verify:release` for TypeScript, lint, integration tests, production build, built Google/admin tests and Chromium component interactions. The test suite uses synthetic providers; it does not verify live Google credentials. Run `pnpm audit --prod` separately for current advisories.
