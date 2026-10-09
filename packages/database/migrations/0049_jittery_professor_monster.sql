CREATE TABLE `video_viewer_grants` (
	`id` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`email` varchar(255) NOT NULL,
	`invitedByUserId` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp,
	CONSTRAINT `video_viewer_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `video_email_idx` UNIQUE(`videoId`,`email`)
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `defaultVideoVisibility` varchar(7);--> statement-breakpoint
ALTER TABLE `video_viewer_grants` ADD CONSTRAINT `video_viewer_grants_videoId_videos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;