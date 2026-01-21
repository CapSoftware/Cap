CREATE TABLE `video_editor_projects` (
	`id` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`config` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_editor_projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_video_owner` UNIQUE(`videoId`,`ownerId`)
);
--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `video_editor_projects` (`videoId`);--> statement-breakpoint
CREATE INDEX `owner_id_idx` ON `video_editor_projects` (`ownerId`);