ALTER TABLE `storage_integrations` ADD `googleDriveAccessToken` text;--> statement-breakpoint
ALTER TABLE `storage_integrations` ADD `googleDriveAccessTokenExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `storage_integrations` ADD `googleDriveTokenRefreshLeaseId` varchar(64);--> statement-breakpoint
ALTER TABLE `storage_integrations` ADD `googleDriveTokenRefreshLeaseExpiresAt` timestamp;