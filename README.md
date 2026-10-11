# Foodlane

Foodlane helps people discover nearby food from local cooks and sellers. Customers can explore dishes, search by neighborhood, view seller locations, and share dish reviews or interest. Sellers can publish a menu after their account and selling place are reviewed.

**Live site:** [foodlane.nowshinaranini.workers.dev](https://foodlane.nowshinaranini.workers.dev)

## What you can do

- Browse and search food, sellers, and neighborhoods.
- Explore location-based results and open seller directions in Google Maps.
- Create a buyer or seller account using Google sign-in.
- Submit seller identity and selling-place information for private review.
- Publish, edit, or pause food listings after seller approval.
- Mark interest and leave reviews for individual dishes; recommend sellers separately.
- Review seller submissions, moderate accounts, and inspect audit activity from the admin area.

Interest is not an order. Foodlane does not process checkout, payment, or delivery. Seller verification confirms the submitted identity and selling-place details; it is not a food-safety certification.

## Technology

- React 19, TypeScript, Vinext, and Vite
- Cloudflare Workers for the application runtime
- Cloudflare D1 with Drizzle ORM for application data
- Cloudflare R2 and Images for file storage and image processing
- Supabase Auth for Google sign-in
- Google Maps for map views and directions

## Run locally

### Requirements

- Node.js 22.13 or newer
- pnpm 11.25

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Create a local, ignored `.dev.vars` file for development credentials and runtime settings. Do not copy credentials from a shared example file or commit local environment files. Keep the development `AUTH_BASE_URL` aligned with the local site URL and allow insecure HTTP only for loopback development.

For local seller-photo and private-verification flows, initialize the local database and private-storage configuration:

```sh
pnpm db:migrate:local
node scripts/configure-private-local.mjs
```

Start the development server:

```sh
pnpm dev
```

The usual local URL is `http://localhost:5173`. Use the port printed by the server if it differs.

### Google Maps browser key

Map embeds and directions use Google Maps. To enable interactive pin placement with the Google Maps JavaScript API, add a browser key to the ignored `.env.production.local` file:

```text
VITE_GOOGLE_MAPS_API_KEY=your-restricted-browser-key
```

The key is delivered to browsers, so restrict it to the Maps JavaScript API and Foodlane’s HTTP referrers. Never use a private server credential as a browser key. Without it, the app displays Google Maps embeds and supports location entry through coordinates or device location.

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm verify:release` runs the broader local release checks, including the production build and browser-oriented checks. It does not apply remote migrations, configure production credentials, or verify the deployed service.

## Database and deployment

Database migrations live in [`drizzle/`](drizzle/). For an intentional production schema change, make and verify a D1 backup before applying migrations:

```sh
pnpm db:migrate:remote
```

Build and deploy the Worker with the production configuration and an ignored production secrets file:

```sh
pnpm build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js deploy --config dist/server/wrangler.json --secrets-file .env.production
```

Keep production credentials out of source control. Review the Cloudflare bindings and secret names in the deployment output, then smoke-test the public pages and protected admin routes. The build wrapper removes its local `.dev.vars` preview sidecar after building.

## Security and privacy

- Seller identity evidence is private and visible to authorized reviewers under the app’s MFA controls.
- After a review decision, the NID number and verification-only details are erased from the active record; private originals are queued for deletion.
- Public seller locations and images are shown only under the app’s consent and approval rules.
- Account suspension and deletion are handled through authenticated admin and account controls.
- Keep backups, environment files, local databases, credentials, and runtime state out of Git.

See [`PRIVATE_DATA_RUNBOOK.md`](PRIVATE_DATA_RUNBOOK.md), [`SECURITY_RUNBOOK.md`](SECURITY_RUNBOOK.md), [`ADMIN_ACCOUNTS_RUNBOOK.md`](ADMIN_ACCOUNTS_RUNBOOK.md), and [`SUPABASE_AUTH_RUNBOOK.md`](SUPABASE_AUTH_RUNBOOK.md) for operational details.

## Project structure

```text
app/          Application pages and UI
components/   Shared interface components
db/           Database schema definitions
drizzle/      Database migrations
lib/          Server-side application and domain logic
scripts/      Development, migration, and release helpers
tests/        Authentication, authorization, privacy, and feature tests
```

## Contributing

Keep secrets and personal data out of code, logs, screenshots, fixtures, and pull requests. Before proposing a change, run the checks relevant to it and document any required migration or production configuration change.
