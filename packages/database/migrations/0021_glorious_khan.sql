ALTER TABLE `s3_buckets` ADD `organizationId` varchar(15);--> statement-breakpoint
ALTER TABLE `storage_integrations` ADD `organizationId` varchar(15);--> statement-breakpoint
CREATE INDEX `owner_organization_idx` ON `s3_buckets` (`ownerId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `s3_buckets` (`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_provider_idx` ON `storage_integrations` (`organizationId`,`provider`);--> statement-breakpoint
CREATE INDEX `organization_active_idx` ON `storage_integrations` (`organizationId`,`active`,`status`);