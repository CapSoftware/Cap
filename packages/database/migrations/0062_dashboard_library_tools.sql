ALTER TABLE `space_videos` ADD `position` int;--> statement-breakpoint
ALTER TABLE `videos` ADD `archivedAt` timestamp;--> statement-breakpoint
CREATE INDEX `org_owner_folder_archived_effective_idx` ON `videos` (`orgId`,`ownerId`,`folderId`,`archivedAt`,`effectiveCreatedAt`);