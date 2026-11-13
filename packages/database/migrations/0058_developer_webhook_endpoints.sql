CREATE TABLE `developer_webhook_endpoints` (
	`id` varchar(15) NOT NULL,
	`appId` varchar(15) NOT NULL,
	`url` varchar(2048) NOT NULL,
	`secretPrefix` varchar(12) NOT NULL,
	`encryptedSecret` text NOT NULL,
	`events` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`disabledReason` varchar(32),
	`lastDeliveryAt` timestamp,
	`lastDeliveryStatus` varchar(16),
	`lastResponseStatus` int,
	`lastErrorCode` varchar(32),
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`failingSince` timestamp,
	`deletedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `developer_webhook_endpoints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `developer_webhook_endpoints` ADD CONSTRAINT `developer_webhook_endpoints_appId_developer_apps_id_fk` FOREIGN KEY (`appId`) REFERENCES `developer_apps`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `dev_webhooks_app_list_idx` ON `developer_webhook_endpoints` (`appId`,`deletedAt`,`createdAt`,`id`);