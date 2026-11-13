ALTER TABLE `developer_transcripts` ADD `videoId` varchar(15);--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_video_idx` ON `developer_transcripts` (`appId`,`videoId`,`createdAt`,`id`);