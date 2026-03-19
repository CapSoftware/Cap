CREATE TABLE `auth_api_keys` (
	`id` varchar(36) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auth_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_api_keys_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
RENAME TABLE `space_invites` TO `organization_invites`;--> statement-breakpoint
RENAME TABLE `space_members` TO `organization_members`;--> statement-breakpoint
RENAME TABLE `spaces` TO `organizations`;--> statement-breakpoint
ALTER TABLE `shared_videos` RENAME COLUMN `spaceId` TO `organizationId`;--> statement-breakpoint
ALTER TABLE `organization_invites` RENAME COLUMN `spaceId` TO `organizationId`;--> statement-breakpoint
ALTER TABLE `organization_members` RENAME COLUMN `spaceId` TO `organizationId`;--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `activeSpaceId` TO `activeOrganizationId`;--> statement-breakpoint
ALTER TABLE `organization_invites` DROP INDEX `space_invites_id_unique`;--> statement-breakpoint
ALTER TABLE `organization_members` DROP INDEX `space_members_id_unique`;--> statement-breakpoint
ALTER TABLE `organizations` DROP INDEX `spaces_id_unique`;--> statement-breakpoint
DROP INDEX `space_id_idx` ON `shared_videos`;--> statement-breakpoint
DROP INDEX `video_id_space_id_idx` ON `shared_videos`;--> statement-breakpoint
DROP INDEX `space_id_idx` ON `organization_invites`;--> statement-breakpoint
DROP INDEX `space_id_idx` ON `organization_members`;--> statement-breakpoint
DROP INDEX `user_id_space_id_idx` ON `organization_members`;--> statement-breakpoint
ALTER TABLE `organization_invites` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `organization_members` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `organizations` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `organization_members` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `iconUrl` varchar(1024);--> statement-breakpoint
ALTER TABLE `videos` ADD `password` text;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD CONSTRAINT `organization_invites_id_unique` UNIQUE(`id`);--> statement-breakpoint
ALTER TABLE `organization_members` ADD CONSTRAINT `organization_members_id_unique` UNIQUE(`id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `organizations_id_unique` UNIQUE(`id`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `shared_videos` (`organizationId`);--> statement-breakpoint
CREATE INDEX `video_id_organization_id_idx` ON `shared_videos` (`videoId`,`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `organization_invites` (`organizationId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `organization_members` (`organizationId`);--> statement-breakpoint
CREATE INDEX `user_id_organization_id_idx` ON `organization_members` (`userId`,`organizationId`);