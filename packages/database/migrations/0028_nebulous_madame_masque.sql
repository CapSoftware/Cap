ALTER TABLE `folders` ADD `public` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `spaces` ADD `public` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `public_parent_id_idx` ON `folders` (`public`,`parentId`);--> statement-breakpoint
CREATE INDEX `public_idx` ON `spaces` (`public`);