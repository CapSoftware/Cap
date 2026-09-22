CREATE TABLE `loom_migration_imports` (
	`videoId` varchar(15) NOT NULL,
	`requestId` varchar(15) NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `loom_migration_imports_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
CREATE TABLE `loom_migration_requests` (
	`id` varchar(15) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`activeOrganizationId` varchar(15),
	`requestedByUserId` varchar(15) NOT NULL,
	`workspaceName` varchar(255),
	`customerNote` text,
	`customerReply` text,
	`invitedAt` datetime,
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`capMessage` text,
	`expectedVideoCount` int,
	`importedVideoCount` int NOT NULL DEFAULT 0,
	`queuedVideoCount` int NOT NULL DEFAULT 0,
	`activeImportCount` int NOT NULL DEFAULT 0,
	`lastOperatorUserId` varchar(15),
	`lastOperatorAt` datetime,
	`completedAt` datetime,
	`createdAt` datetime NOT NULL,
	`updatedAt` datetime NOT NULL,
	CONSTRAINT `loom_migration_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `loom_migration_active_org_idx` UNIQUE(`activeOrganizationId`)
);
--> statement-breakpoint
CREATE INDEX `loom_migration_imports_request_idx` ON `loom_migration_imports` (`requestId`);--> statement-breakpoint
CREATE INDEX `loom_migration_org_created_idx` ON `loom_migration_requests` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `loom_migration_status_created_idx` ON `loom_migration_requests` (`status`,`createdAt`);