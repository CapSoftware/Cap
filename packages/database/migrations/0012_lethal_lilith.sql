CREATE TABLE `developer_api_keys` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`keyType` varchar(8) NOT NULL,
	`keyPrefix` varchar(12) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`encryptedKey` text NOT NULL,
	`lastUsedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `developer_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `key_hash_idx` UNIQUE(`keyHash`)
);
--> statement-breakpoint
CREATE TABLE `developer_app_domains` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`domain` varchar(253) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `developer_app_domains_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_domain_unique` UNIQUE(`appId`,`domain`)
);
--> statement-breakpoint
CREATE TABLE `developer_apps` (
	`id` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`name` varchar(255) NOT NULL,
	`environment` varchar(16) NOT NULL,
	`logoUrl` varchar(1024),
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `developer_apps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `developer_credit_accounts` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`balanceMicroCredits` bigint unsigned NOT NULL DEFAULT 0,
	`stripeCustomerId` varchar(255),
	`stripePaymentMethodId` varchar(255),
	`autoTopUpEnabled` boolean NOT NULL DEFAULT false,
	`autoTopUpThresholdMicroCredits` bigint unsigned NOT NULL DEFAULT 0,
	`autoTopUpAmountCents` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `developer_credit_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_id_unique` UNIQUE(`appId`)
);
--> statement-breakpoint
CREATE TABLE `developer_credit_transactions` (
	`id` varchar(15) NOT NULL,
	`accountId` varchar(15) NOT NULL,
	`type` varchar(16) NOT NULL,
	`amountMicroCredits` bigint NOT NULL,
	`balanceAfterMicroCredits` bigint unsigned NOT NULL,
	`referenceId` varchar(255),
	`referenceType` varchar(32),
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `developer_credit_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `developer_daily_storage_snapshots` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`snapshotDate` varchar(10) NOT NULL,
	`totalDurationMinutes` float NOT NULL DEFAULT 0,
	`videoCount` int NOT NULL DEFAULT 0,
	`microCreditsCharged` bigint unsigned NOT NULL DEFAULT 0,
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `developer_daily_storage_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `app_date_unique` UNIQUE(`appId`,`snapshotDate`)
);
--> statement-breakpoint
CREATE TABLE `developer_videos` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`externalUserId` varchar(255),
	`name` varchar(255) NOT NULL DEFAULT 'Untitled',
	`duration` float,
	`width` int,
	`height` int,
	`fps` int,
	`s3Key` varchar(512),
	`transcriptionStatus` varchar(16),
	`metadata` json,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `developer_videos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `organization_members` ADD `hasProSeat` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `developer_api_keys` ADD CONSTRAINT `developer_api_keys_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `developer_app_domains` ADD CONSTRAINT `developer_app_domains_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `developer_credit_accounts` ADD CONSTRAINT `developer_credit_accounts_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `developer_credit_transactions` ADD CONSTRAINT `dev_credit_txn_account_fk` FOREIGN KEY (`accountId`) REFERENCES `developer_credit_accounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `developer_daily_storage_snapshots` ADD CONSTRAINT `developer_daily_storage_snapshots_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD CONSTRAINT `developer_videos_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `app_key_type_idx` ON `developer_api_keys` (`appId`,`keyType`);--> statement-breakpoint
CREATE INDEX `owner_deleted_idx` ON `developer_apps` (`ownerId`,`deletedAt`);--> statement-breakpoint
CREATE INDEX `account_type_created_idx` ON `developer_credit_transactions` (`accountId`,`type`,`createdAt`);--> statement-breakpoint
CREATE INDEX `account_ref_dedup_idx` ON `developer_credit_transactions` (`accountId`,`referenceId`,`referenceType`);--> statement-breakpoint
CREATE INDEX `app_created_idx` ON `developer_videos` (`appId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `app_user_idx` ON `developer_videos` (`appId`,`externalUserId`);--> statement-breakpoint
CREATE INDEX `app_deleted_idx` ON `developer_videos` (`appId`,`deletedAt`);