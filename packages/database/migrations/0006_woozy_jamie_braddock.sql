ALTER TABLE `space_videos` ADD `folderId` varchar(15);--> statement-breakpoint
CREATE INDEX `folder_id_idx` ON `space_videos` (`folderId`);