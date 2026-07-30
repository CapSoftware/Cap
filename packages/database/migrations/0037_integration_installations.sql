CREATE TABLE `integration_installations` (
	`id` varchar(15) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`externalId` varchar(255) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`installedByUserId` varchar(15) NOT NULL,
	`encryptedCredentials` text NOT NULL,
	`metadata` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `integration_installations_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_external_id_idx` UNIQUE(`provider`,`externalId`)
);
--> statement-breakpoint
CREATE INDEX `organization_provider_display_name_idx` ON `integration_installations` (`organizationId`,`provider`,`displayName`);