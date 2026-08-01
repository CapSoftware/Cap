CREATE TABLE `product_analytics_reconciliation_failures` (
	`sourceHash` varchar(64) NOT NULL,
	`sourceType` varchar(32) NOT NULL,
	`errorCode` varchar(64) NOT NULL,
	`attemptCount` int NOT NULL DEFAULT 1,
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_reconciliation_failures_sourceHash` PRIMARY KEY(`sourceHash`)
);
--> statement-breakpoint
ALTER TABLE `product_analytics_ingestion_leases` ADD `fencingToken` bigint unsigned NOT NULL;--> statement-breakpoint
CREATE INDEX `source_type_idx` ON `product_analytics_reconciliation_failures` (`sourceType`,`lastSeenAt`);--> statement-breakpoint
CREATE INDEX `analytics_reconciliation_idx` ON `comments` (`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `analytics_reconciliation_idx` ON `users` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `analytics_created_at_idx` ON `videos` (`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `analytics_first_view_at_idx` ON `videos` (`firstExternalViewAt`,`id`);