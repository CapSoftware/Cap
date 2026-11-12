CREATE TABLE `developer_transcripts` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`externalUserId` varchar(255),
	`name` varchar(255) NOT NULL DEFAULT 'Untitled',
	`status` varchar(16) NOT NULL,
	`sourceType` varchar(8) NOT NULL,
	`sourceUrl` varchar(2048),
	`s3Key` varchar(512),
	`resultKey` varchar(512),
	`sourceBytes` bigint unsigned,
	`durationSeconds` float,
	`requestedLanguage` varchar(16),
	`language` varchar(16),
	`text` mediumtext,
	`wordCount` int,
	`reservedMicroCredits` bigint unsigned NOT NULL DEFAULT 0,
	`billedMicroCredits` bigint unsigned NOT NULL DEFAULT 0,
	`errorCode` varchar(64),
	`errorMessage` varchar(512),
	`metadata` json,
	`runId` varchar(32),
	`queuedAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `developer_transcripts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `developer_transcripts` ADD CONSTRAINT `developer_transcripts_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_list_idx` ON `developer_transcripts` (`appId`,`deletedAt`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_user_idx` ON `developer_transcripts` (`appId`,`externalUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_status_idx` ON `developer_transcripts` (`appId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `dev_transcripts_status_updated_idx` ON `developer_transcripts` (`status`,`updatedAt`);