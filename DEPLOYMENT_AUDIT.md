# Foodlane deployment audit — 7 October 2026

**Verdict: not ready for a public production launch.** The production bundle builds and the local checks are strong, but the remote database is behind the code, account deletion has a recoverability gap, and the current production integration test does not verify Google authentication and admin approval.

Audited the working tree in `G:/foodlane`, branch `main`, base commit `0d7164f`, including existing modified and untracked files. This is an audit of the current checkout, not just the committed version. No deployment, remote migration, account provisioning, or production-data mutation was performed. Only this report and ignored local audit/test artifacts were created.

## Confirmed findings, in priority order

### 1. P1 — Remote D1 is missing three required migrations

Read-only `wrangler d1 migrations list DB --remote` reports these pending migrations:

- `0010_supabase_auth.sql`: provider access/refresh token and expiry columns.
- `0011_common_black_crow.sql`: account mobile number and deletion feedback.
- `0012_spotty_alex_power.sql`: seller recommendations.

The latest authentication and catalogue queries reference these fields/tables. Deploying the current application against that schema would break Google session persistence, profile reads, and catalogue/recommendation requests.

Evidence: [0010](G:/foodlane/drizzle/0010_supabase_auth.sql:1), [0011](G:/foodlane/drizzle/0011_common_black_crow.sql:1), [0012](G:/foodlane/drizzle/0012_spotty_alex_power.sql:1), [session creation](G:/foodlane/lib/supabase-auth.ts:75), [catalogue query](G:/foodlane/lib/foodlane-api.ts:163).

Release action: review the migrations, confirm the intended database and recovery plan, apply the pending migrations during the release, and verify the schema before enabling the new code. Local data/submissions and admin provisioning do not transfer to the remote database.

### 2. P1 — Account deletion can strand local personal data after deleting the login identity

`deleteAccountData` deletes the Supabase user first, then reads D1 and eventually runs its local deletion transaction. If a subsequent D1 read/transaction fails, the provider identity is already gone while local profile, seller, and verification data can remain. The user cannot sign in with that deleted identity to retry cleanup; there is no durable deletion workflow recorded before the provider deletion.

A synthetic fault probe against the transpiled source confirmed the ordering: Supabase deletion succeeded, the next D1 read failed, and the request failed before local cleanup. No real identity or data was deleted.

Evidence: [provider deletion precedes D1 work](G:/foodlane/lib/verification-retention.ts:40), [local transaction](G:/foodlane/lib/verification-retention.ts:76).

Release action: persist a deletion request and revoke serving access before cross-service work; make provider deletion and D1/R2 cleanup retryable and idempotent. Add failure-injection coverage for provider success followed by D1 failure. Simply swapping the two destructive operations leaves a different partial-failure problem.

### 3. P1 — Production-flow verification is failing and still targets retired authentication

The built-Worker test fails on its obsolete `/Resend/` privacy-policy assertion. Its login helper also calls `/api/auth/sign-in/email`, which the active Google-only handler returns 404 for. It lacks Supabase configuration/provider doubles and cannot exercise the current session path after that assertion is corrected.

Most authorization/verification tests use `TEST_ONLY_BETTER_AUTH=true`; these are valuable checks of shared permissions and data logic, but do not establish the full production Google-session → admin MFA → document review → approval journey. The four dedicated Supabase tests cover initial OAuth/session creation and basic denial/rate limits using a provider test double. They do not cover a successful refresh or cross-service account deletion.

Evidence: [old login helper](G:/foodlane/tests/admin-built.test.mjs:21), [failing assertion](G:/foodlane/tests/admin-built.test.mjs:23), [legacy authorization harness](G:/foodlane/tests/roles.test.mjs:68), [Supabase tests](G:/foodlane/tests/supabase-auth.test.mjs:42).

Release action: update the built integration test to use the active Google session path and complete an end-to-end staging journey with synthetic verification images. Verify approval unlocks listing creation, rejection keeps it locked, and anonymous/buyer/seller requests cannot fetch private documents.

### 4. P2 — Temporary Supabase refresh failures permanently remove Foodlane sessions

Any unsuccessful refresh response, including HTTP 429/500/503, triggers deletion of the local session. A temporary provider outage therefore becomes a forced sign-out for users whose access tokens need refresh. A synthetic HTTP 503 probe reproduced `signedIn=false` and `sessionDeleted=true`.

Evidence: [refresh failure branch](G:/foodlane/lib/supabase-auth.ts:87).

Action: revoke only on confirmed invalid/revoked credentials; preserve the session during transient upstream failures and return a retryable unavailable response. Keep protected access denied during the failure. Test successful refresh, concurrent refresh, invalid refresh, rate limiting, and provider outages.

### 5. P2 — Offers are displayed as a feature but cannot be created or persisted

The Offers shelf requires `original_price > price`. The food table has no offer fields, the strict food API accepts neither `original_price` nor `offer_label`, the catalogue omits them, and the seller listing form has no offer editor. Real seller offers will never populate that shelf through the current product.

Evidence: [Offers filter](G:/foodlane/app/discovery-shelves.tsx:80), [strict food input](G:/foodlane/lib/foodlane-api.ts:18), [food schema](G:/foodlane/db/schema.ts:4).

Action: implement validated offer fields across migration, seller editor, API, and discovery, or hide the unavailable feature for the first release. Best deals currently means lowest listed price, as its subtitle states; it does not represent a discount.

### 6. P2 — Food search and discovery rankings only consider the newest 200 dishes

The global catalogue returns `ORDER BY f.rowid DESC LIMIT 200`, and food/cuisine/place filtering and discovery ranking happen in the browser on that subset. Once there are more than 200 available dishes, older foods cannot be found through that search and highly recommended older sellers may be absent from collection rankings. Seller-name search uses a separate endpoint, so it has a different scope.

Evidence: [global cap](G:/foodlane/lib/foodlane-api.ts:170), [client search/filtering](G:/foodlane/app/foodlane.tsx:47).

Action: move food search/filtering/ranking to paginated server queries before growing beyond this cap. A small pilot below the cap is unaffected.

### 7. P2 — Retention failures lack reliable operational visibility

Worker observability is disabled. The scheduled handler catches failures and only logs a generic code; the promise then resolves successfully. Individual R2 deletion failures are retained as retry jobs, but the scheduled handler does not publish failure/backlog counts or alert an operator. Sensitive document cleanup can fail without a failed scheduler outcome or an established alert.

Evidence: [observability configuration](G:/foodlane/wrangler.jsonc:11), [swallowed scheduler failure](G:/foodlane/worker.ts:46), [retry jobs](G:/foodlane/lib/verification-retention.ts:25).

Action: enable appropriately redacted operational logging, expose counts/health for pending and failed deletion jobs, and alert on missed runs or increasing backlog. Verify actual deployed cron execution and failure recovery before accepting real identity documents.

## Dependencies and documentation

`pnpm audit --prod --json` reports **10 advisories: 1 critical, 4 high, 3 moderate, 2 low**. These are dependency-scan findings, not proof that every advisory is exploitable in this Worker.

- Installed `next@16.3.4` is listed in [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), patched in 16.3.6. The advisory concerns attacker-controlled SVG in the Node `next/og` ImageResponse implementation. No application `ImageResponse`/`next/og` import was found, and this app uses Vinext on Cloudflare. Current application exposure was not demonstrated.
- The override pins `sharp@0.35.4`; [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) lists a fix in 0.35.5. Production uploads use Cloudflare Images and validate JPEG/PNG; Sharp is used in the test pipeline. No deployed Sharp exploit path was demonstrated.
- Remaining advisories affect Browserslist, source-map-js, baseline-browser-mapping, esbuild, Babel, and fast-uri, including optional/build tooling paths. Update compatible patched versions and re-run the audit and checks; document any accepted exceptions with reachability evidence. Do not blindly force major dependency upgrades.

Supabase reports the Foodlane project as `ACTIVE_HEALTHY`. Its security advisor reports leaked-password protection disabled. This is conditional: the app is Google-only, but the Supabase dashboard's email-provider setting was not verified. Disable unused password authentication there, or configure protection if it is intentionally enabled. [Supabase remediation guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

The privacy policy still describes password authentication and omits the newly added recommendation feature. Runbooks contain historical instructions/results for retired email confirmation and Better Auth flows. Update the current operational instructions and privacy text before release. This audit does not establish legal compliance.

## Checks completed

| Check | Result / scope |
| --- | --- |
| TypeScript | Passed: `pnpm typecheck` |
| Full lint | Passed, no errors/warnings |
| Main automated suite | 63 passed, 0 failed; mixes legacy isolated harness and active Supabase tests |
| Production build | Passed, all five Vinext environments built |
| Built admin integration | Failed on stale `/Resend/` assertion; current authenticated flow unverified |
| Existing browser interaction test | 1 passed; account deletion/moderation components with API doubles |
| Additional built-Worker smoke | Home, Discover, Map, login, and catalogue return 200; anonymous account/admin pages redirect to login; anonymous document API returns 403 |
| Local browser inspection | Home and Discover are distinct; Burgers filter works; inspected tab reported no captured warning/error logs |
| Remote D1 | Three pending migrations confirmed |
| Remote R2 settings | Both actual configured buckets: r2.dev disabled and no custom domains |
| Public Worker URL | `https://foodlane.nowshinaranini.workers.dev/` returned HTTP 404; current application is not verified live there |
| Client artifact secret scan | No literal matches for the local auth secret, Supabase secret key, or NID key-ring values in JS/JSON/map/HTML files under `dist/client`; not a comprehensive secret audit |

The build copies local `.dev.vars` into ignored `dist/server/.dev.vars`. That file contains development configuration/secrets and must not be shared as part of a public build archive. The generated deployment config retains the HTTPS production origin and has local HTTP disabled. Secrets and runtime state are ignored by Git.

## Unverified production gates

These are not confirmed misconfigurations:

- Production secret names/availability: the read-only inspection was declined. Required bindings include `BETTER_AUTH_SECRET`, Supabase URL/publishable key (supported aliases are documented), server-only `SUPABASE_SECRET_KEY` for account deletion, and a production `NID_ENCRYPTION_KEYS` key ring. Never set the test-only legacy-auth binding in production.
- Live Google provider settings, production callback allowlist, Google consent-screen readiness, and full callback/refresh on the deployed origin.
- Production admin provisioning and authenticator enrollment. The local admin grant for `nowshinaranini@gmail.com` does not grant remote permissions. The review desk is `/admin`, backed by Cloudflare D1 and private R2; Supabase supplies the identity service.
- Deployed Images transformations, maximum upload/resource limits, actual cron delivery/retry behavior, and anonymous retrieval denial for synthetic document objects.
- Backup/restore procedure, encryption-key recovery/rotation, deletion handling after restore, monitoring alerts, and traffic/load behavior.
- Mobile/responsive and keyboard accessibility coverage beyond the existing component tests and the inspected local filter interaction.

Essential implementation and migration files remain untracked. A deployment built from a Git checkout will omit them until they are included in the release commit. There is no checked-in `.github` CI workflow establishing these release checks automatically.

## Recommended release order

1. Repair deletion recoverability and transient refresh handling; update tests to cover the active Google-session path.
2. Resolve dependency advisories and decide whether to finish or hide Offers. Update current privacy/operational documentation.
3. Include all intended source, migrations, and lockfile changes in a reproducible release snapshot; exclude local secrets/runtime artifacts.
4. Prepare a staging release with the reviewed migrations and required production bindings. Confirm Google callbacks and provision the intended remote admin, then complete MFA.
5. Run a synthetic seller journey: submit → private admin review → approve/reject → list food → buyer interest/recommendation/review → withdraw portrait → delete account. Inject cleanup failures and verify retries and alerts.
6. Verify deployed image processing, document privacy, retention cron, recovery plan, and production URL health before public launch.

**Ready for continued local/staging validation; not yet signed off for real users or real identity documents.**

## Remediation checkpoint - 8 October 2026

The findings above describe the pre-fix audit. Local code fixes and administrator account controls passed verification; production checks remain pending. See [DEPLOYMENT_FIXES.md](DEPLOYMENT_FIXES.md) for current status and evidence, and [ADMIN_ACCOUNTS_RUNBOOK.md](ADMIN_ACCOUNTS_RUNBOOK.md) for usage.
