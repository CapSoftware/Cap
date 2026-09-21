ALTER TABLE `loom_migration_requests` ADD `activeImportLeaseToken` varchar(36);--> statement-breakpoint
ALTER TABLE `loom_migration_requests` ADD `activeImportLeaseUntil` datetime;