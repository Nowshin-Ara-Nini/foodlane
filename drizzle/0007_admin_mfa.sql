CREATE TABLE `admin_mfa` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`setup_session` text NOT NULL,
	`setup_expires` integer NOT NULL,
	`last_counter` integer DEFAULT -1 NOT NULL,
	`proof_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `admin_mfa_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`proof_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `auth_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_admin_mfa_user` ON `admin_mfa_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `admin_recovery_codes` (
	`digest` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_recovery_user` ON `admin_recovery_codes` (`user_id`);