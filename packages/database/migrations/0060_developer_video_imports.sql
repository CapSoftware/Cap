CREATE TABLE `developer_video_imports` (
	`videoId` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`keyId` varchar(15) NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'downloading',
	`bytes` bigint unsigned,
	`errorCode` varchar(32),
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `developer_video_imports_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `developer_video_imports` ADD CONSTRAINT `developer_video_imports_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `dev_imports_app_state_idx` ON `developer_video_imports` (`appId`,`state`);--> statement-breakpoint
CREATE INDEX `dev_imports_key_created_idx` ON `developer_video_imports` (`keyId`,`createdAt`);