CREATE TABLE `media_processing_budgets` (
	`id` varchar(64) NOT NULL,
	`reserved_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`limit_bytes` bigint unsigned NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `media_processing_budgets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `media_budget_expiry_idx` ON `media_processing_budgets` (`expires_at`);