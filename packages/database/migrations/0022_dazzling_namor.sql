ALTER TABLE `s3_buckets` ADD `active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `s3_buckets` ADD `createdAt` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `s3_buckets` ADD `updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
CREATE INDEX `organization_active_idx` ON `s3_buckets` (`organizationId`,`active`,`updatedAt`);