ALTER TABLE `accounts` DROP INDEX `accounts_id_unique`;--> statement-breakpoint
ALTER TABLE `folders` DROP INDEX `folders_id_unique`;--> statement-breakpoint
ALTER TABLE `organization_invites` DROP INDEX `organization_invites_id_unique`;--> statement-breakpoint
ALTER TABLE `organization_members` DROP INDEX `organization_members_id_unique`;--> statement-breakpoint
ALTER TABLE `organizations` DROP INDEX `organizations_id_unique`;--> statement-breakpoint
ALTER TABLE `sessions` DROP INDEX `sessions_id_unique`;--> statement-breakpoint
ALTER TABLE `sessions` DROP INDEX `sessions_sessionToken_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP INDEX `users_id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP INDEX `users_email_unique`;--> statement-breakpoint
ALTER TABLE `videos` DROP INDEX `videos_id_unique`;--> statement-breakpoint
DROP INDEX `user_id_idx` ON `organization_members`;--> statement-breakpoint
DROP INDEX `owner_id_idx` ON `organizations`;--> statement-breakpoint
DROP INDEX `id_idx` ON `videos`;--> statement-breakpoint
ALTER TABLE `videos` ADD `effectiveCreatedAt` datetime GENERATED ALWAYS AS (COALESCE(
          STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.customCreatedAt')), '%Y-%m-%dT%H:%i:%s.%fZ'),
          STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.customCreatedAt')), '%Y-%m-%dT%H:%i:%sZ'),
          `createdAt`
        )) STORED;--> statement-breakpoint
CREATE INDEX `owner_id_tombstone_idx` ON `organizations` (`ownerId`,`tombstoneAt`);--> statement-breakpoint
CREATE INDEX `org_owner_folder_idx` ON `videos` (`orgId`,`ownerId`,`folderId`);--> statement-breakpoint
CREATE INDEX `org_effective_created_idx` ON `videos` (`orgId`,`effectiveCreatedAt`);