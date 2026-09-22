CREATE TABLE `mcp_oauth_registration_quotas` (
	`windowId` varchar(10) NOT NULL,
	`registrations` int NOT NULL DEFAULT 0,
	`expiresAt` timestamp NOT NULL,
	CONSTRAINT `mcp_oauth_registration_quotas_windowId` PRIMARY KEY(`windowId`)
);
--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `mcp_oauth_registration_quotas` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `client_active_idx` ON `mcp_oauth_tokens` (`clientId`,`revokedAt`,`refreshExpiresAt`);