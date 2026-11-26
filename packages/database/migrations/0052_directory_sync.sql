CREATE TABLE `directory_users` (
	`id` varchar(64) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`directoryId` varchar(64) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`email` varchar(255) NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `directory_users_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `organization_directory_sync` (
	`organizationId` varchar(15) NOT NULL,
	`requestedAt` datetime,
	`syncedAt` datetime,
	`leaseExpiresAt` datetime,
	`lastError` varchar(255),
	`heldRemovals` int NOT NULL DEFAULT 0,
	`removalsApprovedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organization_directory_sync_organizationId` PRIMARY KEY(`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `directory_users_organization_id_idx` ON `directory_users` (`organizationId`);--> statement-breakpoint
CREATE INDEX `directory_users_user_org_idx` ON `directory_users` (`userId`,`organizationId`);