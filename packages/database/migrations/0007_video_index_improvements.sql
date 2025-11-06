ALTER TABLE `users`
  DROP INDEX `users_id_unique`,
  DROP INDEX `users_email_unique`;

ALTER TABLE `accounts`
  DROP INDEX `accounts_id_unique`;

ALTER TABLE `sessions`
  DROP INDEX `sessions_id_unique`,
  DROP INDEX `sessions_sessionToken_unique`;

ALTER TABLE `organizations`
  DROP INDEX `organizations_id_unique`,
  DROP INDEX `owner_id_idx`,
  ADD INDEX `owner_id_tombstone_idx` (`ownerId`, `tombstoneAt`);

ALTER TABLE `organization_members`
  DROP INDEX `organization_members_id_unique`,
  DROP INDEX `user_id_idx`;

ALTER TABLE `organization_invites`
  DROP INDEX `organization_invites_id_unique`;

ALTER TABLE `folders`
  DROP INDEX `folders_id_unique`;

ALTER TABLE `videos`
  DROP INDEX `videos_id_unique`,
  DROP INDEX `id_idx`,
  ADD COLUMN `effectiveCreatedAt` datetime GENERATED ALWAYS AS (
    COALESCE(
      STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.customCreatedAt')), '%Y-%m-%dT%H:%i:%s.%fZ'),
      STR_TO_DATE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.customCreatedAt')), '%Y-%m-%dT%H:%i:%sZ'),
      `createdAt`
    )
  ) STORED AFTER `createdAt`,
  ADD INDEX `org_owner_folder_idx` (`orgId`, `ownerId`, `folderId`),
  ADD INDEX `org_effective_created_idx` (`orgId`, `effectiveCreatedAt`);
