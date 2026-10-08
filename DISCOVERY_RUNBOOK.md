# Step 5: maps and seller engagement

Step 5 is implemented locally. Stop here for owner approval before step 6. No public deployment or remote migrations were performed.

## Maps and public profiles

- Leaflet 1.9.4 is loaded dynamically in the browser, so server rendering does not require `window`. Its CSS is bundled with the app.
- `/map` lists approved sellers, including those without available food. Markers match the current results page and link to `/sellers/[id]`. Sample food cards never become map markers.
- The default map center is Dhanmondi; the initial search lists all approved sellers. **Near me** searches within 5 km of a browser-provided location. Users can choose another radius, up to 100 km, or click/drag the search pin and submit **Search this area**. Denied/unavailable geolocation leaves manual coordinates and map selection available.
- Profile and verification forms have a draggable pin and coordinate fields. The required public-location notice and unchecked consent remain in verification. Moving a previously approved business still requires review and renewed consent.
- Public seller pages show the approved public location, sanitized place photo, optional consented portrait, available foods and average rating. Media routes still recheck seller status/consent and use `private, no-store`. Native image elements avoid an image optimizer cache that could bypass those checks.
- OpenStreetMap tile attribution remains visible. Requests go directly to `https://tile.openstreetmap.org/{z}/{x}/{y}.png`; browser caching is left intact. No offline tile prefetching or tile proxy was added. Keep the normal browser Referrer header for tile requests. The standard tile service has no SLA; review traffic capacity or arrange another tile provider before high-volume use. Map viewport/IP are sent to the tile provider; include this processor in the step 6 privacy policy.

References: [Leaflet reference](https://leafletjs.com/reference.html), [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## API contracts

| Route | Contract |
| --- | --- |
| `GET /api/public/sellers` | Optional paired `lat`/`lng`; `radius` 0.1–100 km (default 5); `page` 1–10000; `limit` 1–100 (default 20). Returns public seller projections, distance when searched, total and pagination. Unknown/duplicate parameters fail validation. |
| `GET /api/public/sellers/{id}?page=1` | Approved seller, up to 200 available foods and 20 reviews/page. Missing/pending/rejected/suspended sellers return 404. No private verification fields or storage keys. |
| `GET /api/buyer/interests` | Current buyer's approved seller IDs. |
| `POST /api/buyer/interest` | `{sellerId}`. Repeated clicks succeed without adding another row. No toggle/removal operation. |
| `GET /api/buyer/reviews/{sellerId}` | Current buyer's own review or null. |
| `POST /api/buyer/review` | `{sellerId,rating,body}`. Integer rating 1–5, trimmed body 1–1000 characters. Display name comes from the authenticated account. Duplicate creation returns 409. |
| `POST /api/buyer/review/edit` | Same payload, but updates only the authenticated buyer's existing review. No existing review returns 404. |
| `GET /api/seller/dashboard` | Includes `interestCount`, a seller-level total, not a sum across dishes. |

Buyer mutations require a verified buyer session and same-origin CSRF checks. Sellers/admins cannot post reviews or interest. The catalogue now projects seller-level counts/ratings for every dish. No client-supplied user ID or reviewer name is accepted. General API abuse limits remain step 6 work.

Discovery first restricts SQL candidates by latitude/longitude bounding boxes, splitting across the antimeridian using OR and including all longitudes when the radius reaches a pole. Haversine distance uses Earth radius 6371.0088 km. Exact radius filtering, ascending distance and stable ID tie-breaking precede pagination. Candidates are not prematurely truncated. D1 candidate volume and aggregate-query cost should be load-tested with the intended production dataset before activation.

## Migration

`drizzle/0008_seller_engagement.sql` adds `seller_interests` and `seller_reviews` with buyer/seller composite primary keys, foreign keys with deletion cascades, rating bounds and lookup/discovery indexes. Previous migrations remain unchanged.

The migration merges legacy food-level interests by buyer/seller. Where multiple dish reviews exist, it keeps the latest review (food ID breaks timestamp ties). Only extant buyer accounts are migrated. Legacy engagement rows are cleared after transfer; their tables remain for migration-history compatibility and are no longer written by application routes. Existing profile/food data is preserved. Account cleanup deletes new engagement rows through foreign-key cascades.

Applied to local test D1 successfully:

```sh
npm run db:migrate:local
```

For a fresh remote test database, after configuring its binding and reaching the deployment approval gate:

```sh
npm run db:migrate:remote
```

Fresh resources apply 0000–0008 in order. Never replay the transfer migration manually against populated engagement tables or rewrite an applied migration.

## Verification and remaining checks

Checkpoint results: TypeScript and production build passed; 45 regression tests plus one compiled-Worker journey passed (46 total). Migration 0008 applied successfully to local D1. Targeted lint for the new discovery/map/seller-page modules and changed API/tests passed. Full-project lint still reports 19 errors and 6 warnings in existing `app/foodlane.tsx`, `app/verification-form.tsx`, and `app/auth/auth-form.tsx`; the release lint gate is not yet satisfied.

Automated checks cover migration deduplication, concurrent clicks/review creation, explicit review edits and ownership, malformed search input, antimeridian/poles, exact-radius exclusion of bounding-box corners, filtering before pagination, public/private projections, consent withdrawal, pending/rejected/suspended exclusion, and engagement erasure on buyer/seller account deletion. Existing auth, private documents, image metadata, retention and MFA regressions are included.

Commands:

```sh
npm run typecheck
npm run test
npm run build
npm run test:built
npm run lint
```

The built test also renders `/`, `/map` and `/sellers/[id]` through the compiled Worker and verifies no map iframe remains. This is HTTP/server-render testing, not a browser journey.

No browser is connected to the available automation tool. Before release, manually verify desktop/mobile map tiles and attribution, draggable registration/search pins, marker links, geolocation allow/deny, pagination, seller media, buyer create/edit review, and seller dashboard totals. Live Google/Resend, deployed hashing CPU, remote private-bucket settings and full-project lint remain release checks from earlier steps. Step 6 reporting/suspension workflow, account-deletion UI, final abuse limits and privacy policy are intentionally not started.


## Final-step update

Step 6 is now implemented locally, including report moderation, reauthenticated account deletion, API limits and privacy policy. Earlier checkpoint statements about pending step 6 work or full-project lint failures are historical. See [SECURITY_RUNBOOK.md](SECURITY_RUNBOOK.md) for current results and deployment blockers.

## Explore map update, 7 October 2026
Explore map now uses Google Maps for the searched address or selected public seller pin. Each seller has Show on map, profile and Google Maps directions actions. Sample sellers are excluded.
The search form accepts road/landmark, neighborhood, city and district instead of visible coordinates. Duplicate city/district names are removed. Named searches match all comma-separated parts against published serving addresses; no geocoding or radius is implied. Google resolves the corresponding map address separately. Near me still uses internal coordinates and exact distance, with a default 5 km radius and a maximum of 100 km.
GET /api/public/sellers accepts location (1-400 characters, comma-separated address parts) as well as existing seller name search and near-me parameters. Empty, punctuation-only and duplicate location parameters fail validation. Pending/suspended sellers remain excluded.
The Google consumer map embed was verified in the browser for Dhaka and Road 12, Gulshan 1, Dhaka. Search/directions links use the documented Maps URLs: https://developers.google.com/maps/documentation/urls/get-started .
Privacy copy describes both providers. Seller pin editors and other existing map views retain their Leaflet workflow. No new migration or Maps Platform billing setup was required.
