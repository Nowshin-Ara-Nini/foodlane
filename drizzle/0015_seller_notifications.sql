CREATE TABLE `seller_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `auth_users`(`id`) ON DELETE CASCADE,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `seller_notifications_user_created` ON `seller_notifications` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `seller_notifications_user_read` ON `seller_notifications` (`user_id`,`read_at`);
