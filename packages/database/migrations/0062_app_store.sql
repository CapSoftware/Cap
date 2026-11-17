CREATE TABLE `app_store_events` (
	`id` varchar(64) NOT NULL,
	`type` varchar(64) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `app_store_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `app_store_installations` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(64) NOT NULL,
	`scope` varchar(16) NOT NULL,
	`scopeKey` varchar(64) NOT NULL,
	`userId` varchar(15),
	`organizationId` varchar(15),
	`installedByUserId` varchar(15) NOT NULL,
	`appVersion` varchar(32) NOT NULL,
	`grantedPermissions` json NOT NULL,
	`grantedEvents` json NOT NULL,
	`encryptedSettings` text,
	`status` varchar(16) NOT NULL DEFAULT 'active',
	`disabledReason` varchar(64),
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`failingSince` timestamp,
	`lastDeliveryAt` timestamp,
	`lastDeliveryStatus` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_store_installations_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_store_installations_app_scope_idx` UNIQUE(`appId`,`scopeKey`)
);
--> statement-breakpoint
CREATE INDEX `app_store_events_created_at_idx` ON `app_store_events` (`createdAt`);--> statement-breakpoint
CREATE INDEX `app_store_installations_user_idx` ON `app_store_installations` (`userId`);--> statement-breakpoint
CREATE INDEX `app_store_installations_organization_idx` ON `app_store_installations` (`organizationId`);