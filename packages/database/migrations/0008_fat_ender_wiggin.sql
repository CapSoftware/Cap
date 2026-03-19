ALTER TABLE `auth_api_keys` DROP INDEX `auth_api_keys_id_unique`;--> statement-breakpoint
ALTER TABLE `comments` DROP INDEX `comments_id_unique`;--> statement-breakpoint
ALTER TABLE `notifications` DROP INDEX `notifications_id_unique`;--> statement-breakpoint
ALTER TABLE `s3_buckets` DROP INDEX `s3_buckets_id_unique`;--> statement-breakpoint
ALTER TABLE `shared_videos` DROP INDEX `shared_videos_id_unique`;--> statement-breakpoint
ALTER TABLE `space_members` DROP INDEX `space_members_id_unique`;--> statement-breakpoint
ALTER TABLE `space_videos` DROP INDEX `space_videos_id_unique`;--> statement-breakpoint
ALTER TABLE `spaces` DROP INDEX `spaces_id_unique`;--> statement-breakpoint
DROP INDEX `video_id_idx` ON `comments`;--> statement-breakpoint
DROP INDEX `recipient_id_idx` ON `notifications`;--> statement-breakpoint
DROP INDEX `video_id_idx` ON `shared_videos`;--> statement-breakpoint
DROP INDEX `space_id_idx` ON `space_members`;--> statement-breakpoint
DROP INDEX `space_id_user_id_idx` ON `space_members`;--> statement-breakpoint
DROP INDEX `space_id_idx` ON `space_videos`;--> statement-breakpoint
CREATE INDEX `video_type_created_idx` ON `comments` (`videoId`,`type`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `space_id_folder_id_idx` ON `space_videos` (`spaceId`,`folderId`);