ALTER TABLE `user_passkeys` ADD `confirmsIdentity` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `user_consumed_idx` ON `mcp_oauth_codes` (`userId`,`consumedAt`);--> statement-breakpoint
CREATE INDEX `user_revoked_idx` ON `mcp_oauth_tokens` (`userId`,`revokedAt`);