CREATE INDEX `video_id_idx` ON `notifications` (`videoId`);--> statement-breakpoint
CREATE INDEX `started_at_idx` ON `video_uploads` (`started_at`);--> statement-breakpoint
CREATE INDEX `org_owner_folder_effective_idx` ON `videos` (`orgId`,`ownerId`,`folderId`,`effectiveCreatedAt`);