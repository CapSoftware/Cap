ALTER TABLE `notifications` MODIFY COLUMN `type` varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedupKey` varchar(128);--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `dedup_key_idx` UNIQUE(`dedupKey`);