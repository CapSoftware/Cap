CREATE TABLE `loops_sync_jobs` (
	`userId` varchar(15) NOT NULL,
	`revision` int NOT NULL DEFAULT 1,
	`nextAttemptAt` datetime NOT NULL,
	`leaseToken` varchar(36),
	`leaseUntil` datetime,
	`failures` int NOT NULL DEFAULT 0,
	`lastError` varchar(64),
	`profileHash` varchar(64),
	`syncedEmail` varchar(255),
	`lastSyncedAt` datetime,
	CONSTRAINT `loops_sync_jobs_userId` PRIMARY KEY(`userId`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `marketingOrigin` varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX `loops_sync_due_idx` ON `loops_sync_jobs` (`nextAttemptAt`);