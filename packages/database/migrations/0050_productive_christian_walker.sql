CREATE TABLE `loom_import_job_items` (
	`id` varchar(15) NOT NULL,
	`job_id` varchar(15) NOT NULL,
	`csv_row` int NOT NULL,
	`loom_url` varchar(1024) NOT NULL,
	`loom_video_id` varchar(64),
	`owner_email` varchar(255),
	`space_name` varchar(255),
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`owner_id` varchar(15),
	`space_id` varchar(15),
	`video_id` varchar(15),
	`title` varchar(255),
	`loom_created_at` datetime(3),
	`duration_seconds` float,
	`width` int,
	`height` int,
	`thumbnail_url` varchar(1024),
	`error` varchar(512),
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `loom_import_job_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `job_row_idx` UNIQUE(`job_id`,`csv_row`)
);
--> statement-breakpoint
CREATE TABLE `loom_import_jobs` (
	`id` varchar(15) NOT NULL,
	`org_id` varchar(15) NOT NULL,
	`created_by_id` varchar(15) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'checking',
	`total_count` int NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`started_at` datetime(3),
	`completed_at` datetime(3),
	CONSTRAINT `loom_import_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `job_status_row_idx` ON `loom_import_job_items` (`job_id`,`status`,`csv_row`);--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `loom_import_job_items` (`video_id`);--> statement-breakpoint
CREATE INDEX `org_creator_created_idx` ON `loom_import_jobs` (`org_id`,`created_by_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `status_updated_idx` ON `loom_import_jobs` (`status`,`updated_at`);