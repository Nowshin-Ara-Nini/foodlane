ALTER TABLE `auth_sessions` ADD `provider_access_token` text;
--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `provider_refresh_token` text;
--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `provider_expires_at` integer;
