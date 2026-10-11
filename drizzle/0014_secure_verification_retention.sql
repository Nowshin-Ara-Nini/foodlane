CREATE TABLE `seller_verifications_new` (
  `id` text PRIMARY KEY NOT NULL,
  `seller_id` text NOT NULL,
  `legal_name` text NOT NULL,
  `age` integer,
  `gender` text,
  `personal_email` text NOT NULL,
  `personal_phone` text NOT NULL,
  `home_address` text,
  `nid_ciphertext` text,
  `nid_iv` text,
  `nid_key_version` text,
  `place_address` text,
  `place_lat` real,
  `place_lng` real,
  `note` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `created` text NOT NULL,
  `location_notice_version` text NOT NULL,
  `location_accepted_at` text NOT NULL,
  `portrait_consent` integer DEFAULT 0 NOT NULL,
  `portrait_consent_at` text,
  `portrait_withdrawn_at` text,
  `reviewed_by` text,
  `reviewed_at` text,
  `decision_note` text,
  `decision_id` text,
  `retention_due_at` text,
  `review_details_purged_at` text
);
--> statement-breakpoint
INSERT INTO seller_verifications_new (id,seller_id,legal_name,age,gender,personal_email,personal_phone,home_address,nid_ciphertext,nid_iv,nid_key_version,place_address,place_lat,place_lng,note,status,created,location_notice_version,location_accepted_at,portrait_consent,portrait_consent_at,portrait_withdrawn_at,reviewed_by,reviewed_at,decision_note,decision_id,retention_due_at)
SELECT id,seller_id,legal_name,age,gender,personal_email,personal_phone,home_address,nid_ciphertext,nid_iv,nid_key_version,place_address,place_lat,place_lng,note,status,created,location_notice_version,location_accepted_at,portrait_consent,portrait_consent_at,portrait_withdrawn_at,reviewed_by,reviewed_at,decision_note,decision_id,retention_due_at FROM seller_verifications;
--> statement-breakpoint
DROP TABLE seller_verifications;
--> statement-breakpoint
ALTER TABLE seller_verifications_new RENAME TO seller_verifications;
--> statement-breakpoint
CREATE INDEX `idx_private_verification_seller` ON `seller_verifications` (`seller_id`,`created`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_one_pending_submission` ON `seller_verifications` (`seller_id`) WHERE `seller_verifications`.`status` = 'pending';
--> statement-breakpoint
UPDATE seller_verifications SET age=NULL,gender=NULL,home_address=NULL,nid_ciphertext=NULL,nid_iv=NULL,nid_key_version=NULL,place_address=NULL,place_lat=NULL,place_lng=NULL,note=NULL,review_details_purged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),retention_due_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reviewed_at IS NOT NULL;
--> statement-breakpoint
UPDATE verification_files SET delete_after=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE bucket='private' AND state='attached' AND submission_id IN (SELECT id FROM seller_verifications WHERE reviewed_at IS NOT NULL);
