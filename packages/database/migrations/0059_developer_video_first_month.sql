ALTER TABLE `developer_videos` ADD `storagePaidUntil` timestamp;--> statement-breakpoint
CREATE INDEX `app_storage_idx` ON `developer_videos` (`appId`,`deletedAt`,`status`,`maxResolutionTier`,`width`,`height`,`storagePaidUntil`,`duration`);--> statement-breakpoint
CREATE INDEX `first_month_due_idx` ON `developer_videos` (`storagePaidUntil`,`status`,`createdAt`);