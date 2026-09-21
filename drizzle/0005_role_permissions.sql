PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`bio` text NOT NULL,
	`address` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`hours` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sellers`("id", "owner", "name", "phone", "bio", "address", "lat", "lng", "hours", "status", "updated") SELECT "id", "owner", "name", "phone", "bio", "address", "lat", "lng", "hours", "status", "updated" FROM `sellers`;--> statement-breakpoint
DROP TABLE `sellers`;--> statement-breakpoint
ALTER TABLE `__new_sellers` RENAME TO `sellers`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `sellers_owner_unique` ON `sellers` (`owner`);--> statement-breakpoint
ALTER TABLE `auth_users` ADD `role` text DEFAULT 'buyer' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_users` ADD `role_chosen` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE auth_users SET role = CASE WHEN EXISTS (SELECT 1 FROM sellers WHERE sellers.owner = auth_users.id) THEN 'seller' ELSE 'buyer' END, role_chosen = 1;
--> statement-breakpoint
UPDATE sellers SET status = 'pending' WHERE status = 'unverified';
