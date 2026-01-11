ALTER TABLE `video_uploads` ADD `phase` varchar(32) DEFAULT 'uploading' NOT NULL;--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `processing_progress` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `processing_message` varchar(255);--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `processing_error` text;--> statement-breakpoint
ALTER TABLE `video_uploads` ADD `raw_file_key` varchar(512);