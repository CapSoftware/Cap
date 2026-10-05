CREATE TABLE `directory_users` (
	`id` varchar(15) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`directoryId` varchar(255) NOT NULL,
	`directoryUserId` varchar(255) NOT NULL,
	`idpId` varchar(255) NOT NULL,
	`userId` varchar(15),
	`email` varchar(255),
	`firstName` varchar(255),
	`lastName` varchar(255),
	`state` varchar(32) NOT NULL,
	`lastError` varchar(64),
	`remoteUpdatedAt` datetime(3) NOT NULL,
	`lastSeenAt` datetime(3) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `directory_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `directory_user_workos_idx` UNIQUE(`directoryUserId`),
	CONSTRAINT `directory_user_identity_idx` UNIQUE(`directoryId`,`idpId`),
	CONSTRAINT `directory_user_org_user_idx` UNIQUE(`organizationId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `organization_directory_sync` (
	`organizationId` varchar(15) NOT NULL,
	`workosOrganizationId` varchar(255) NOT NULL,
	`directoryId` varchar(255),
	`state` varchar(32) NOT NULL DEFAULT 'pending',
	`eventCursor` varchar(255),
	`eventStartedAt` datetime(3) NOT NULL,
	`reconcileStartedAt` datetime(3),
	`reconcileCursor` varchar(255),
	`reconcileListingComplete` boolean NOT NULL DEFAULT false,
	`lastReconciledAt` datetime(3),
	`lastSyncedAt` datetime(3),
	`nextAttemptAt` datetime(3) NOT NULL,
	`leaseToken` varchar(36),
	`leaseUntil` datetime(3),
	`lastError` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organization_directory_sync_organizationId` PRIMARY KEY(`organizationId`),
	CONSTRAINT `directory_sync_directory_idx` UNIQUE(`directoryId`)
);
--> statement-breakpoint
CREATE INDEX `directory_user_org_email_idx` ON `directory_users` (`organizationId`,`email`);--> statement-breakpoint
CREATE INDEX `directory_user_reconcile_idx` ON `directory_users` (`directoryId`,`state`,`lastSeenAt`);--> statement-breakpoint
CREATE INDEX `directory_sync_due_idx` ON `organization_directory_sync` (`nextAttemptAt`);