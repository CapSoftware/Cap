ALTER TABLE `shared_videos`
  DROP INDEX `shared_videos_id_unique`,
  DROP INDEX `video_id_idx`;

ALTER TABLE `comments`
  DROP INDEX `comments_id_unique`,
  DROP INDEX `video_id_idx`,
  ADD INDEX `video_type_created_idx` (`videoId`, `type`, `createdAt`, `id`);

ALTER TABLE `notifications`
  DROP INDEX `notifications_id_unique`,
  DROP INDEX `recipient_id_idx`;

ALTER TABLE `s3_buckets`
  DROP INDEX `s3_buckets_id_unique`;

ALTER TABLE `auth_api_keys`
  DROP INDEX `auth_api_keys_id_unique`;

ALTER TABLE `spaces`
  DROP INDEX `spaces_id_unique`;

ALTER TABLE `space_members`
  DROP INDEX `space_members_id_unique`,
  DROP INDEX `space_id_idx`,
  DROP INDEX `space_id_user_id_idx`;

ALTER TABLE `space_videos`
  DROP INDEX `space_videos_id_unique`,
  DROP INDEX `space_id_idx`,
  ADD INDEX `space_id_folder_id_idx` (`spaceId`, `folderId`);
