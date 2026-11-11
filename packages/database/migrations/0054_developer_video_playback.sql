ALTER TABLE `developer_videos` ADD `status` varchar(16) DEFAULT 'uploading' NOT NULL;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `playbackId` varchar(64);--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `maxResolutionTier` varchar(8) DEFAULT '1080p' NOT NULL;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `renditions` json;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `storedBytes` bigint unsigned;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `errorReason` varchar(512);--> statement-breakpoint
ALTER TABLE `developer_videos` ADD `processing` json;--> statement-breakpoint
ALTER TABLE `developer_videos` ADD CONSTRAINT `playback_id_idx` UNIQUE(`playbackId`);