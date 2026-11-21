CREATE TABLE `app_flags` (
	`key` varchar(64) NOT NULL,
	`value` json NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `app_flags_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `share_ladders` (
	`video_id` varchar(15) NOT NULL,
	`owner_id` varchar(15) NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'candidate',
	`source_key` varchar(512) NOT NULL,
	`source_etag` varchar(128),
	`source_bytes` bigint unsigned,
	`view_hits` int NOT NULL DEFAULT 0,
	`views_checked_at` datetime(3),
	`output_prefix` varchar(512),
	`renditions` json,
	`attempts` int NOT NULL DEFAULT 0,
	`job_id` varchar(255),
	`error` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `share_ladders_video_id` PRIMARY KEY(`video_id`)
);
--> statement-breakpoint
CREATE INDEX `share_ladders_state_idx` ON `share_ladders` (`state`);