CREATE TABLE `seller_interests` (
	`seller_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created` text NOT NULL,
	PRIMARY KEY(`seller_id`, `user_id`),
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seller_interests_user` ON `seller_interests` (`user_id`);--> statement-breakpoint
CREATE TABLE `seller_reviews` (
	`seller_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`rating` integer NOT NULL,
	`body` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	PRIMARY KEY(`seller_id`, `user_id`),
	FOREIGN KEY (`seller_id`) REFERENCES `sellers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "seller_reviews_rating" CHECK("seller_reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `seller_reviews_user` ON `seller_reviews` (`user_id`);--> statement-breakpoint
CREATE INDEX `seller_reviews_recent` ON `seller_reviews` (`seller_id`,`created`);--> statement-breakpoint
CREATE INDEX `sellers_discovery` ON `sellers` (`status`,`lat`,`lng`);
--> statement-breakpoint
INSERT INTO seller_interests(seller_id,user_id,created)
SELECT DISTINCT f.seller_id,i.user_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM interests i JOIN foods f ON f.id=i.food_id JOIN auth_users u ON u.id=i.user_id WHERE u.role='buyer';
--> statement-breakpoint
INSERT INTO seller_reviews(seller_id,user_id,name,rating,body,created,updated)
SELECT seller_id,user_id,name,rating,body,created,created FROM (
 SELECT f.seller_id,r.user_id,r.name,r.rating,r.body,r.created,ROW_NUMBER() OVER(PARTITION BY f.seller_id,r.user_id ORDER BY r.created DESC,r.food_id) rank
 FROM reviews r JOIN foods f ON f.id=r.food_id JOIN auth_users u ON u.id=r.user_id WHERE u.role='buyer' AND r.rating BETWEEN 1 AND 5
) WHERE rank=1;
--> statement-breakpoint
DELETE FROM interests;
--> statement-breakpoint
DELETE FROM reviews;
