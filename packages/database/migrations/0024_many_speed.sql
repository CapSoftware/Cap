CREATE TABLE `video_edits` (
	`videoId` varchar(15) NOT NULL,
	`sourceKey` varchar(512) NOT NULL,
	`editSpec` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_edits_videoId` PRIMARY KEY(`videoId`)
);
--> statement-breakpoint
ALTER TABLE `video_edits` ADD CONSTRAINT `video_edits_videoId_videos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;