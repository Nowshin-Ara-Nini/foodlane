# Private verification: step 3

Keep public deployment disabled until all six checkpoints are approved. Use synthetic identity documents until production storage, encryption, image processing and admin MFA have been checked. Admin MFA and the full audit panel are step 4; account deletion's reauthenticated public flow is step 6.

## Migration and local setup

`0006_private_verification.sql` follows the already-applied `0005_role_permissions` migration. Do not renumber or rewrite earlier migrations.

```powershell
npm.cmd run db:migrate:local
node scripts/configure-private-local.mjs
npm.cmd run dev
```

The migration creates `seller_verifications`, `verification_files` and `audit_log`. It queues legacy verification and food files for deletion before dropping plaintext verification tables. Legacy test sellers become pending, their unused legacy phone field is cleared, and their old food images are disabled and cleared. They must resubmit verification and upload sanitized food images. This is the approved fresh-test-data cutover, not a migration for a live database of real identity records. D1 historical backups/time-travel copies are not erased by SQL row deletion; never reuse a historical production database or bucket for this cutover.

The local helper adds a random AES key to ignored `.dev.vars` without printing or replacing an existing key. Authentication/email credentials still need to be configured separately. Restart development after changing bindings or secrets.

```powershell
npm.cmd run test:privacy
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run verification:cleanup:local
```

The cleanup command runs the **built scheduled handler** against local `.wrangler/state` resources and prints counts only. Build again after changing code. The pinned Wrangler asset-proxy preview does not forward scheduled events correctly ([upstream issue #9882](https://github.com/cloudflare/workers-sdk/issues/9882)); the helper dispatches directly to the Worker. It does not contact remote buckets. Local builds may copy `.dev.vars` into ignored `dist/server`; never distribute that directory with its local secrets.

## Production configuration (not performed)

1. Create fresh D1 and R2 resources. Replace the placeholder D1 ID and bucket names in `wrangler.jsonc`. `PRIVATE_VERIFICATIONS` must be a distinct bucket from `BUCKET`.
2. Disable **both** buckets' public development URLs and remove all custom domains. Even public portrait copies must be accessible only through the application route so withdrawal checks cannot be bypassed. Do not create presigned document URLs, public file proxies, Pages bucket mounts, or routes accepting arbitrary keys.

   ```powershell
   npx.cmd wrangler r2 bucket dev-url disable foodlane-private-verifications
   npx.cmd wrangler r2 bucket dev-url disable foodlane-media
   npx.cmd wrangler r2 bucket dev-url get foodlane-private-verifications
   npx.cmd wrangler r2 bucket dev-url get foodlane-media
   npx.cmd wrangler r2 bucket domain list foodlane-private-verifications
   npx.cmd wrangler r2 bucket domain list foodlane-media
   ```

   Require development access **disabled** and **no custom domains**. Remove any existing domains in the dashboard, then recheck. Binding configuration alone cannot prove an existing bucket is private. Verify guessed object URLs cannot retrieve a synthetic document after provisioning. See [R2 public access](https://developers.cloudflare.com/r2/buckets/public-buckets/) and [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).
3. Store `NID_ENCRYPTION_KEYS` using `npx.cmd wrangler secret put NID_ENCRYPTION_KEYS`. Its value is a JSON object such as `{"v1":"<base64 encoding of 32 cryptographically random bytes>"}`. Generate and retain production keys securely; never copy the local key, commit keys or print them to logs. `NID_KEY_VERSION=v1` selects the key for new submissions. Keep prior versions in the key ring until all affected records have been re-encrypted or deleted; changing the active version does not re-encrypt existing records. AES-256-GCM uses a fresh 12-byte IV and binds ciphertext to its submission ID.

Key rotation procedure: generate a fresh independent 32-byte key with a cryptographic random generator. Add it to NID_ENCRYPTION_KEYS under a new version while retaining the old key, set NID_KEY_VERSION to the new version, and deploy both together. Submit a synthetic verification and confirm the new version encrypts/decrypts; confirm any still-pending old-version submission remains readable. Do not replace the key ring with only the new key. Retire an old version only after no active pending row uses it and the database recovery window has elapsed. If a key is suspected compromised, stop reviewing old ciphertext, rotate immediately, and require affected applicants to resubmit rather than restoring trust in the compromised key.

Key recovery procedure: keep an encrypted recovery copy of the complete versioned key ring in an approved secrets vault separate from the Worker deployment, with access limited to named operators. Test that an authorized operator can retrieve it during scheduled recovery reviews; never place the recovery copy in source control, a project file, or general-purpose backups. If the active key is lost, restore the exact key version from the protected recovery copy before allowing pending reviews. If it cannot be recovered, affected pending NIDs cannot be decrypted: stop those reviews, request new submissions, and do not claim the ciphertext was recovered. Do not retire an old key until no pending records need it and the database recovery window has elapsed.
4. Enable the `IMAGES` binding. The application sends bytes directly to Cloudflare Images, not through public URLs. Test real JPEG/PNG decoding, all mirrored EXIF orientations, output metadata removal and maximum-size CPU usage on the target plan. The local emulator only partly implements transformations; eight-orientation pixel tests additionally use a full Sharp-backed adapter. See [Images binding](https://developers.cloudflare.com/images/optimization/binding/).
5. After the final deployment approvals, migrate the intended **fresh** remote database:

   ```powershell
   npm.cmd run db:migrate:remote
   ```

6. Verify the deployed scheduled handler and daily `0 3 * * *` cron (03:00 UTC). Check backlog/failed job counts and deployed resource limits. Authentication hashing CPU suitability is still a separate deployment prerequisite. No production resource or secret was provisioned by step 3.

## Storage, consent and access

- All uploaded images: JPEG/PNG only, at most 5 MiB, at most 16 megapixels, maximum side 8192. Validate signatures, dimensions and PNG checksums; decode, normalize EXIF orientation and re-encode through Images. Verify the encoded PNG and keep only pixel, palette and transparency chunks. Original upload bytes are never persisted. Output must also fit 5 MiB. Food images use the same pipeline.
- Private file keys use `nid/{sellerId}/{uuid}.png`, `passport/...`, and `place/...`. Keys never appear in public/seller contracts. A durable staging record precedes R2 writes so interrupted uploads are recoverable.
- Required, initially unchecked location confirmation records a notice version/time. Each submission, including resubmissions after location/photo changes, needs new confirmation. Changing an approved business identity/location immediately makes the seller pending; the replacement location stays hidden until a new submission is approved.
- Portrait consent is separate, optional, initially unchecked, and does not affect eligibility. Approval generates separately sanitized public place/portrait copies. NID files never have public copies. Portrait withdrawal immediately changes authorization, leaves approval intact, and queues only the public portrait copy for deletion. After a review decision, all private originals (NID, passport and selling-place photos) are queued for deletion. A later opt-in requires a new reviewed submission.
- The admin queue returns applicant identifiers and seller display names only. Opening one submission requires a fresh authenticator code; the detail response decrypts only that pending applicant NID and is audited. Document requests also require recent MFA, authorize before lookup, audit access, then stream bytes with private, no-store and nosniff headers without a public URL. Seller responses expose status, decision reason and timestamps, plus their consent setting; public business fields are explicitly projected.
- Public media routes check current approval and current portrait consent on each request. They do not use persistent browser/CDN caching. Withdrawal cannot retract a copy a visitor already saved independently.
- Minimal audit events store an opaque seller subject, action, time and necessary admin reference. They never store names, contact details, NID, document keys or decision free text. Decision reasons remain only in the private verification record until account deletion.


## Access monitoring

Review admin membership, MFA status, verification-detail/document view events, and the reviewed-detail/file-cleanup backlog as part of routine operations and incident response. Keep application logs free of NID values, personal details, document contents, object keys, and raw request bodies. Cloudflare R2 data-access logs can help investigate object reads but are best-effort; use Foodlane’s own admin audit events as the durable record of authorized reveals. Do not treat either log as a substitute for access control.
## Retention and deletion

After approval or rejection, the decision transaction immediately clears NID ciphertext, age, gender, home address, submitted selling-place details and applicant note from the active verification row. Legal name, personal email and phone remain until account deletion. Every private original (NID, passport and selling-place photo) is immediately marked for deletion; the evidence route stops serving it as soon as the decision commits. Approved public place images and consented portrait copies are separate sanitized copies and remain governed by current publication and consent rules.

Migration 0014_secure_verification_retention makes fields nullable, scrubs already reviewed rows, and schedules their private originals for deletion. The scheduled worker also re-scrubs any reviewed row missing review_details_purged_at; this repairs reviewed personal data reintroduced by a D1 restore. On restore, reapply migrations and run the scrub/cleanup before reopening service. Keep the key ring until all pending submissions that use each key have been reviewed or deleted; after decision there is no active NID ciphertext to rotate.

Cleanup runs every 15 minutes, is idempotent, uses bounded batches and clears object keys only after R2 deletion succeeds. Failed deletes retain keys in temporary jobs and get exponential retry times. A backlog remains queued if a run reaches its batch limit. Private originals stop being served immediately after review even if physical R2 deletion is still pending. Monitor pending file jobs and pending reviewed-detail purges without selecting or logging personal data or object keys.

Cloudflare D1 Time Travel can retain prior database history for up to seven days on the Free plan or 30 days on Paid. A restore can reintroduce an earlier copy of reviewed data; keep the service in maintenance until migrations, the reviewed-record scrubber and file cleanup have completed. Do not claim that deletion from active storage erases provider-managed history immediately.

Account deletion overrides normal retention. In-flight uploads remain tracked for their write window and become immediate deletion jobs when the write finishes. The deletion function reports filesPending and never equates queued work with completed file deletion. Only minimal audit events remain after successful account deletion.
## Step 3 verification and limits

- 30 tests pass: authentication, role/ownership matrix, required consent/age checks, metadata removal, all eight orientations, encrypted storage/admin decryption, independent portrait consent/withdrawal, private projections, decision/submission races, decision-time detail purge, private-file deletion, restore scrubbing, account revocation and deletion retries.
- TypeScript and production build pass. New backend, schema, Worker, scripts and tests pass lint. Full-project lint still reports the existing 23 errors and 8 warnings in legacy Foodlane/verification UI and auth UI.
- Local migration applied successfully. Built HTTP smoke checks pass for auth screens, protected pages, retired handlers and anonymous admin-document denials. Built scheduled cleanup succeeds via direct dispatch. Consent controls are checked by React rendering; interactive browser journeys have not been run.
- Real R2 URL denial, remote bucket configuration, deployed Images/CPU behavior and live cron delivery remain deployment checks. MFA denial tests and the full admin panel are step 4, not completed here. Public account deletion UI is step 6.

Stop here and wait for explicit approval before step 4.


## Step 4 update

Admin MFA and the review/audit panel are now implemented; the step 3 limitations above are historical. See [ADMIN_RUNBOOK.md](ADMIN_RUNBOOK.md) for the current authorization checks, 0007 migration and validation results. Remote deployment checks and the step 6 account-deletion UI remain outstanding.


## Final-step update

Step 6 is now implemented locally, including report moderation, reauthenticated account deletion, API limits and privacy policy. Earlier checkpoint statements about pending step 6 work or full-project lint failures are historical. See [SECURITY_RUNBOOK.md](SECURITY_RUNBOOK.md) for current results and deployment blockers.
