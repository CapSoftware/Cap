CREATE TABLE `marketing_contacts` (
	`emailHash` varchar(64) NOT NULL,
	`email` varchar(255),
	`userId` varchar(15),
	`consent` varchar(20) NOT NULL DEFAULT 'unknown',
	`source` varchar(64) NOT NULL,
	`teammate` boolean NOT NULL DEFAULT false,
	`imported` boolean NOT NULL DEFAULT false,
	`lastAudience` varchar(20),
	`lastProfileHash` varchar(64),
	`lastSyncedAt` datetime,
	`createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `marketing_contacts_emailHash` PRIMARY KEY(`emailHash`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `marketingOrigin` varchar(20) DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX `marketing_contacts_user_idx` ON `marketing_contacts` (`userId`);--> statement-breakpoint
CREATE INDEX `marketing_contacts_sync_idx` ON `marketing_contacts` (`lastSyncedAt`);