CREATE TABLE `video_highlights` (
	`id` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`authorId` varchar(15) NOT NULL,
	`timestamp` float NOT NULL,
	`label` varchar(200),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_highlights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `video_timestamp_idx` ON `video_highlights` (`videoId`,`timestamp`);