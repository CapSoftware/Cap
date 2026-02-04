ALTER TABLE `video_uploads` MODIFY COLUMN `uploaded` bigint unsigned NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `video_uploads` MODIFY COLUMN `total` bigint unsigned NOT NULL DEFAULT 0;
