CREATE TABLE `seller_recommendations` (
	`seller_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`seller_id`, `user_id`),
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seller_recommendations_user` ON `seller_recommendations` (`user_id`);