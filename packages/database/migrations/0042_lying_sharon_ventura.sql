CREATE TABLE `product_analytics_refresh_leases` (
	`name` varchar(64) NOT NULL,
	`ownerId` varchar(36),
	`generation` bigint unsigned NOT NULL DEFAULT 0,
	`sourceCutoff` timestamp,
	`leaseExpiresAt` timestamp,
	`status` varchar(32) NOT NULL DEFAULT 'idle',
	`lastCompletedAt` timestamp,
	`lastErrorCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_refresh_leases_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE INDEX `expiry_idx` ON `product_analytics_refresh_leases` (`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `status_idx` ON `product_analytics_refresh_leases` (`status`);