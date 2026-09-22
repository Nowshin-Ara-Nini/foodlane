# Foodlane

Existing food-discovery app: React 19, TypeScript, Vinext/Vite, Tailwind, shadcn/ui, Lucide, Cloudflare Workers, D1/Drizzle and R2. See [FOODLANE.md](FOODLANE.md) for upgrade checkpoints and configuration.

## Local setup

Use Node >=22.13 and pnpm 11.25.0. On Windows use npm.cmd/npx.cmd if PowerShell blocks script shims.

```sh
npx --yes pnpm@11.25.0 install --frozen-lockfile
```

Copy `.dev.vars.example` to `.dev.vars`, supply a random auth secret, and configure Resend and Google credentials. Never commit `.dev.vars`. The dev origin is http://localhost:5173; AUTH_BASE_URL must exactly match it. HTTP is allowed only for explicit loopback development.

```sh
npm run db:migrate:local
node scripts/configure-private-local.mjs
npm run dev
npm run typecheck
npm run test:auth
npm run test:roles
npm run build
```

The built preview uses Wrangler's printed port; update the local base URL when changing ports. Wrangler configuration is in `wrangler.jsonc`. Public deployment is disabled during the six-step upgrade. Replace its D1 placeholder before remote operations.

## Migrations

```sh
npm run db:generate
npm run db:migrate:local
# Only after preparing the intended Cloudflare database:
npm run db:migrate:remote
```

Wrangler tracks applied migrations. Fresh databases apply 0000–0005 in order. Do not import legacy ChatGPT identities or plaintext test evidence.

The application no longer uses Sites authentication or mock identity headers. `.openai/hosting.json` is historical and is not imported by the build. Existing `scripts/sites-env.mjs` only configures local tool-state locations.


Step 3 private-data setup, retention operations and deployment checks: [PRIVATE_DATA_RUNBOOK.md](PRIVATE_DATA_RUNBOOK.md). Run `npm run test:privacy` for privacy tests and, after building, `npm run verification:cleanup:local` to dispatch local cleanup. Migration 0006 replaces legacy plaintext test verification and disables legacy unsanitized food photos; do not use it as a migration for real historical identity data.


Admin setup and step 4 checks: [ADMIN_RUNBOOK.md](ADMIN_RUNBOOK.md). Visit `/admin` after operator provisioning; enrollment or session verification happens at `/admin/mfa`. Run `npm run test:admin`, and run `npm run test:admin:built` after building to check the built admin journey.


Step 5 maps, public seller pages, near-me search and seller engagement are implemented locally. Migration history now runs through `0008_seller_engagement.sql`; see [DISCOVERY_RUNBOOK.md](DISCOVERY_RUNBOOK.md) for API contracts, migration transfer rules and remaining browser checks. Step 6 and public activation await approval.


Step 6 is implemented locally: reports/moderation, email-confirmed account deletion, API limits, security headers, and `/privacy`. Migration history now runs through `0009_abuse_deletion.sql`. Full-project lint issues from earlier checkpoints are resolved. See [SECURITY_RUNBOOK.md](SECURITY_RUNBOOK.md) for the final acceptance record and deployment gates. Do not activate a public route until those gates and the final owner checkpoint are approved.
