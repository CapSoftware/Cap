ALTER TABLE `videos` ADD `firstExternalViewAt` timestamp;--> statement-breakpoint
CREATE INDEX `first_external_view_at_idx` ON `videos` (`firstExternalViewAt`);