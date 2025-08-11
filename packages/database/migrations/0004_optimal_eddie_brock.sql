ALTER TABLE `folders` ADD `parentId` varchar(15);--> statement-breakpoint
CREATE INDEX `parent_id_idx` ON `folders` (`parentId`);