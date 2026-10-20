DROP INDEX `public_idx` ON `spaces`;--> statement-breakpoint
CREATE INDEX `public_space_parent_id_idx` ON `folders` (`public`,`spaceId`,`parentId`);--> statement-breakpoint
CREATE INDEX `public_organization_id_idx` ON `spaces` (`public`,`organizationId`);