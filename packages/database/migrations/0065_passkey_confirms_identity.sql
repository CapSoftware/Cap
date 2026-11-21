ALTER TABLE `user_passkeys` ADD `confirmsIdentity` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `user_revoked_idx` ON `mcp_oauth_tokens` (`userId`,`revokedAt`);