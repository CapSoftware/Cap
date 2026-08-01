CREATE TABLE `product_analytics_erasure_leases` (
	`name` varchar(64) NOT NULL,
	`ownerId` varchar(64),
	`requestId` varchar(64),
	`fencingToken` bigint unsigned NOT NULL DEFAULT 0,
	`leaseExpiresAt` timestamp,
	`phase` varchar(32) NOT NULL DEFAULT 'idle',
	`pausedPipes` json,
	`userId` varchar(255),
	`organizationId` varchar(255),
	`attemptCount` int NOT NULL DEFAULT 0,
	`lastErrorCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_erasure_leases_name` PRIMARY KEY(`name`)
);
