CREATE TABLE `video_notes` (
	`videoId` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`documentId` varchar(64) NOT NULL,
	`excerpt` varchar(512) NOT NULL DEFAULT '',
	`summaryMarkdown` mediumtext,
	`notesMarkdown` mediumtext,
	`transcript` json,
	`participants` json,
	`meetingStartedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_notes_videoId` PRIMARY KEY(`videoId`),
	CONSTRAINT `owner_document_idx` UNIQUE(`ownerId`,`documentId`)
);
--> statement-breakpoint
ALTER TABLE `videos` ADD `isNote` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `video_notes` ADD CONSTRAINT `video_notes_videoId_videos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `videos`(`id`) ON DELETE cascade ON UPDATE no action;