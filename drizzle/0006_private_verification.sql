CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`action` text NOT NULL,
	`admin_ref` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_time` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_subject` ON `audit_log` (`subject`);--> statement-breakpoint
CREATE TABLE `seller_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`legal_name` text NOT NULL,
	`age` integer NOT NULL,
	`gender` text NOT NULL,
	`personal_email` text NOT NULL,
	`personal_phone` text NOT NULL,
	`home_address` text NOT NULL,
	`nid_ciphertext` text NOT NULL,
	`nid_iv` text NOT NULL,
	`nid_key_version` text NOT NULL,
	`place_address` text NOT NULL,
	`place_lat` real NOT NULL,
	`place_lng` real NOT NULL,
	`note` text NOT NULL,
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
	`retention_due_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_private_verification_seller` ON `seller_verifications` (`seller_id`,`created`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_one_pending_submission` ON `seller_verifications` (`seller_id`) WHERE "seller_verifications"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `verification_files` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`submission_id` text,
	`kind` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`delete_after` text,
	`deleted_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_file_cleanup` ON `verification_files` (`delete_after`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_file_subject` ON `verification_files` (`subject`);--> statement-breakpoint
CREATE INDEX `idx_file_submission` ON `verification_files` (`submission_id`,`kind`);--> statement-breakpoint
-- Fresh-test-data cutover: never migrate plaintext identity data into the new schema.
-- Track deletion BEFORE removing legacy references. Jobs contain keys only until deletion succeeds.
INSERT INTO verification_files (id,subject,kind,bucket,object_key,state,created_at,delete_after)
SELECT 'legacy-nid-'||id,seller_id,'legacy','media',identity_key,'deleting',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM verifications WHERE identity_key!='';
--> statement-breakpoint
INSERT INTO verification_files (id,subject,kind,bucket,object_key,state,created_at,delete_after)
SELECT 'legacy-passport-'||id,seller_id,'legacy','media',passport_key,'deleting',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM verifications WHERE passport_key IS NOT NULL AND passport_key!='';
--> statement-breakpoint
INSERT INTO verification_files (id,subject,kind,bucket,object_key,state,created_at,delete_after)
SELECT 'legacy-place-'||id,seller_id,'legacy','media',selling_key,'deleting',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM verifications WHERE selling_key!='';
--> statement-breakpoint
INSERT INTO verification_files (id,subject,kind,bucket,object_key,state,created_at,delete_after)
SELECT 'legacy-food-'||id,seller_id,'legacy','media',image,'deleting',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM foods WHERE image!='';
--> statement-breakpoint
UPDATE foods SET image='',available=0;
--> statement-breakpoint
UPDATE sellers SET phone='',status='pending';
--> statement-breakpoint
DROP TABLE `verification_logs`;--> statement-breakpoint
DROP TABLE `verifications`;