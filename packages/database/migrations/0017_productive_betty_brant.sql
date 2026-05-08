CREATE TABLE `storage_integrations` (
	`id` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`active` boolean NOT NULL DEFAULT false,
	`encryptedConfig` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `storage_integrations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_objects` (
	`id` varchar(15) NOT NULL,
	`integrationId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`videoId` varchar(15),
	`objectKey` text NOT NULL,
	`objectKeyHash` varchar(64) NOT NULL,
	`providerObjectId` varchar(255) NOT NULL,
	`uploadSessionUrl` text,
	`uploadStatus` varchar(32) NOT NULL DEFAULT 'pending',
	`contentType` varchar(255),
	`contentLength` bigint unsigned,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `storage_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `integration_key_hash_idx` UNIQUE(`integrationId`,`objectKeyHash`)
);
--> statement-breakpoint
ALTER TABLE `videos` ADD `storageIntegrationId` varchar(15);--> statement-breakpoint
CREATE INDEX `owner_provider_idx` ON `storage_integrations` (`ownerId`,`provider`);--> statement-breakpoint
CREATE INDEX `owner_active_idx` ON `storage_integrations` (`ownerId`,`active`);--> statement-breakpoint
CREATE INDEX `integration_status_idx` ON `storage_objects` (`integrationId`,`uploadStatus`);--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `storage_objects` (`videoId`);--> statement-breakpoint
CREATE INDEX `owner_id_idx` ON `storage_objects` (`ownerId`);--> statement-breakpoint
CREATE INDEX `storage_integration_id_idx` ON `videos` (`storageIntegrationId`);