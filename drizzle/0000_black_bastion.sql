CREATE TABLE `foods` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`price` real NOT NULL,
	`category` text NOT NULL,
	`image` text NOT NULL,
	`available` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `interests` (
	`food_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`food_id`, `user_id`),
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verification_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`action` text NOT NULL,
	`note` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`food_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`rating` integer NOT NULL,
	`body` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`food_id`, `user_id`),
	FOREIGN KEY (`food_id`) REFERENCES `foods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`bio` text NOT NULL,
	`address` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`hours` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sellers_owner_unique` ON `sellers` (`owner`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`identity_key` text NOT NULL,
	`selling_key` text NOT NULL,
	`legal_name` text NOT NULL,
	`note` text NOT NULL,
	`status` text NOT NULL,
	`created` text NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE no action
);
