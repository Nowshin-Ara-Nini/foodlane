CREATE TABLE `deletion_challenges` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deletion_challenges_expiry` ON `deletion_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `seller_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	`decision_id` text,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_queue` ON `seller_reports` (`status`,`created`);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_open_pair` ON `seller_reports` (`seller_id`,`user_id`) WHERE "seller_reports"."status"='open';--> statement-breakpoint
CREATE TABLE `seller_suspensions` (
	`seller_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE cascade
);
