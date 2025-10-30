CREATE TABLE `folders` (
	`id` varchar(15) NOT NULL,
	`name` varchar(255) NOT NULL,
	`color` varchar(16) NOT NULL DEFAULT 'normal',
	`organizationId` varchar(15) NOT NULL,
	`createdById` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `folders_id` PRIMARY KEY(`id`),
	CONSTRAINT `folders_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
ALTER TABLE `videos` ADD `folderId` varchar(15);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `folders` (`organizationId`);--> statement-breakpoint
CREATE INDEX `created_by_id_idx` ON `folders` (`createdById`);--> statement-breakpoint
CREATE INDEX `folder_id_idx` ON `videos` (`folderId`);