CREATE INDEX `idx_foods_seller` ON `foods` (`seller_id`);--> statement-breakpoint
CREATE INDEX `idx_logs_seller` ON `verification_logs` (`seller_id`);--> statement-breakpoint
CREATE INDEX `idx_verifications_status` ON `verifications` (`status`);--> statement-breakpoint
CREATE INDEX `idx_verifications_seller` ON `verifications` (`seller_id`);