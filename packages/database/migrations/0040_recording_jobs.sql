CREATE TABLE `video_processing_jobs` (
	`video_id` varchar(15) NOT NULL,
	`owner_id` varchar(15) NOT NULL,
	`generation` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64),
	`state` varchar(32) NOT NULL DEFAULT 'committing',
	`attempt_id` varchar(64),
	`attempt_count` int NOT NULL DEFAULT 0,
	`lease_expires_at` datetime(3),
	`next_retry_at` datetime(3) NOT NULL,
	`workflow_run_id` varchar(255),
	`remote_job_id` varchar(255),
	`source` json,
	`verification` json,
	`output` json,
	`error_code` varchar(64),
	`error_message` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `video_processing_jobs_video_id` PRIMARY KEY(`video_id`)
);
--> statement-breakpoint
CREATE INDEX `processing_state_retry_video_idx` ON `video_processing_jobs` (`state`,`next_retry_at`,`video_id`);--> statement-breakpoint
CREATE INDEX `processing_state_lease_video_idx` ON `video_processing_jobs` (`state`,`lease_expires_at`,`video_id`);