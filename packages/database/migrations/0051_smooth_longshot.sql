CREATE TABLE `loom_import_dispatch_locks` (
	`id` varchar(32) NOT NULL,
	`locked_at` datetime(3) NOT NULL,
	CONSTRAINT `loom_import_dispatch_locks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `loom_import_jobs` ADD `dispatched_at` datetime(3);--> statement-breakpoint
CREATE INDEX `job_updated_idx` ON `loom_import_job_items` (`job_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `status_job_idx` ON `loom_import_job_items` (`status`,`job_id`);