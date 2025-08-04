CREATE TABLE `space_members` (
	`id` varchar(15) NOT NULL,
	`spaceId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`role` varchar(255) NOT NULL DEFAULT 'member',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `space_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `space_members_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `space_videos` (
	`id` varchar(15) NOT NULL,
	`spaceId` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`addedById` varchar(15) NOT NULL,
	`addedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `space_videos_id` PRIMARY KEY(`id`),
	CONSTRAINT `space_videos_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` varchar(15) NOT NULL,
	`primary` boolean NOT NULL DEFAULT false,
	`name` varchar(255) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`createdById` varchar(15) NOT NULL,
	`iconUrl` varchar(255),
	`description` varchar(1000),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`privacy` varchar(255) NOT NULL DEFAULT 'Private',
	CONSTRAINT `spaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `spaces_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `space_members` (`spaceId`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `space_members` (`userId`);--> statement-breakpoint
CREATE INDEX `space_id_user_id_idx` ON `space_members` (`spaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `space_videos` (`spaceId`);--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `space_videos` (`videoId`);--> statement-breakpoint
CREATE INDEX `added_by_id_idx` ON `space_videos` (`addedById`);--> statement-breakpoint
CREATE INDEX `space_id_video_id_idx` ON `space_videos` (`spaceId`,`videoId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `spaces` (`organizationId`);--> statement-breakpoint
CREATE INDEX `created_by_id_idx` ON `spaces` (`createdById`);