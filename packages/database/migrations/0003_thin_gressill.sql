CREATE TABLE `folders` (
	`id` varchar(15) NOT NULL,
	`name` varchar(255) NOT NULL,
	`color` varchar(16) NOT NULL DEFAULT 'normal',
	`organizationId` varchar(15) NOT NULL,
	`createdById` varchar(15) NOT NULL,
	`parentId` varchar(15),
	`spaceId` varchar(15),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `folders_id` PRIMARY KEY(`id`),
	CONSTRAINT `folders_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `imported_videos` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`source` varchar(255) NOT NULL,
	`source_id` varchar(255) NOT NULL,
	CONSTRAINT `imported_videos_orgId_source_source_id_pk` PRIMARY KEY(`orgId`,`source`,`source_id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`recipientId` varchar(15) NOT NULL,
	`type` varchar(10) NOT NULL,
	`data` json NOT NULL,
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `notifications_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_uploads` (
	`video_id` varchar(15) NOT NULL,
	`uploaded` int NOT NULL DEFAULT 0,
	`total` int NOT NULL DEFAULT 0,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	`mode` varchar(255),
	CONSTRAINT `video_uploads_video_id` PRIMARY KEY(`video_id`)
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `settings` json;--> statement-breakpoint
ALTER TABLE `shared_videos` ADD `folderId` varchar(15);--> statement-breakpoint
ALTER TABLE `space_videos` ADD `folderId` varchar(15);--> statement-breakpoint
ALTER TABLE `users` ADD `preferences` json DEFAULT ('null');--> statement-breakpoint
ALTER TABLE `users` ADD `onboardingSteps` json;--> statement-breakpoint
ALTER TABLE `users` ADD `defaultOrgId` varchar(15);--> statement-breakpoint
ALTER TABLE `videos` ADD `duration` float;--> statement-breakpoint
ALTER TABLE `videos` ADD `width` int;--> statement-breakpoint
ALTER TABLE `videos` ADD `height` int;--> statement-breakpoint
ALTER TABLE `videos` ADD `fps` int;--> statement-breakpoint
ALTER TABLE `videos` ADD `settings` json;--> statement-breakpoint
ALTER TABLE `videos` ADD `folderId` varchar(15);--> statement-breakpoint
ALTER TABLE `space_members` ADD CONSTRAINT `space_id_user_id_unique` UNIQUE(`spaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `folders` (`organizationId`);--> statement-breakpoint
CREATE INDEX `created_by_id_idx` ON `folders` (`createdById`);--> statement-breakpoint
CREATE INDEX `parent_id_idx` ON `folders` (`parentId`);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `folders` (`spaceId`);--> statement-breakpoint
CREATE INDEX `recipient_id_idx` ON `notifications` (`recipientId`);--> statement-breakpoint
CREATE INDEX `org_id_idx` ON `notifications` (`orgId`);--> statement-breakpoint
CREATE INDEX `type_idx` ON `notifications` (`type`);--> statement-breakpoint
CREATE INDEX `read_at_idx` ON `notifications` (`readAt`);--> statement-breakpoint
CREATE INDEX `created_at_idx` ON `notifications` (`createdAt`);--> statement-breakpoint
CREATE INDEX `recipient_read_idx` ON `notifications` (`recipientId`,`readAt`);--> statement-breakpoint
CREATE INDEX `recipient_created_idx` ON `notifications` (`recipientId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `folder_id_idx` ON `shared_videos` (`folderId`);--> statement-breakpoint
CREATE INDEX `video_id_folder_id_idx` ON `shared_videos` (`videoId`,`folderId`);--> statement-breakpoint
CREATE INDEX `folder_id_idx` ON `space_videos` (`folderId`);--> statement-breakpoint
CREATE INDEX `folder_id_idx` ON `videos` (`folderId`);