ALTER TABLE `folders` ADD `spaceId` varchar(15);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `folders` (`spaceId`);