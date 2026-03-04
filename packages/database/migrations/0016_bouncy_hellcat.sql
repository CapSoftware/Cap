ALTER TABLE `notifications` ADD `videoId` varchar(50);--> statement-breakpoint
UPDATE `notifications` SET `videoId` = JSON_UNQUOTE(JSON_EXTRACT(`data`, '$.videoId')) WHERE `videoId` IS NULL AND JSON_EXTRACT(`data`, '$.videoId') IS NOT NULL;--> statement-breakpoint
CREATE INDEX `type_recipient_video_created_idx` ON `notifications` (`type`,`recipientId`,`videoId`,`createdAt`);