CREATE TABLE `account_deletion_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_account_deletion_feedback_created` ON `account_deletion_feedback` (`created_at`);--> statement-breakpoint
ALTER TABLE `auth_users` ADD `phone` text;