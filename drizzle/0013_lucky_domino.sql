CREATE TABLE `food_offers` (
	`food_id` text PRIMARY KEY NOT NULL,
	`original_price` real NOT NULL,
	`label` text NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_deletion_jobs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider_required` integer NOT NULL,
	`provider_deleted` integer DEFAULT 0 NOT NULL,
	`requested_by` text,
	`feedback_reason` text,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `account_deletion_jobs_due` ON `account_deletion_jobs` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `cleanup_health` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`failed_at` integer,
	`files_pending` integer DEFAULT 0 NOT NULL,
	`accounts_pending` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `auth_users` ADD `account_status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `banned_by` text;