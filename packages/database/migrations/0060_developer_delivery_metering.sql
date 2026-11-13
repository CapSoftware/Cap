CREATE TABLE `developer_delivery_daily` (
	`appId` varchar(15) NOT NULL,
	`day` date NOT NULL,
	`tier` varchar(8) NOT NULL,
	`seconds` bigint NOT NULL DEFAULT 0,
	`bytes` bigint NOT NULL DEFAULT 0,
	`requests` int NOT NULL DEFAULT 0,
	`final` boolean NOT NULL DEFAULT false,
	`finalizedAt` timestamp,
	`updatedAt` timestamp NOT NULL,
	CONSTRAINT `developer_delivery_daily_appId_day_tier_pk` PRIMARY KEY(`appId`,`day`,`tier`)
);
--> statement-breakpoint
CREATE TABLE `developer_delivery_log_files` (
	`logFile` varchar(191) NOT NULL,
	`etag` varchar(128) NOT NULL,
	`logHour` datetime NOT NULL,
	`parts` json NOT NULL,
	`processedAt` timestamp NOT NULL,
	CONSTRAINT `developer_delivery_log_files_logFile` PRIMARY KEY(`logFile`)
);
--> statement-breakpoint
ALTER TABLE `developer_delivery_daily` ADD CONSTRAINT `developer_delivery_daily_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `day_idx` ON `developer_delivery_daily` (`day`);--> statement-breakpoint
CREATE INDEX `log_hour_idx` ON `developer_delivery_log_files` (`logHour`);