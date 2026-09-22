CREATE TABLE `mcp_oauth_clients` (
	`id` varchar(15) NOT NULL,
	`clientId` varchar(128) NOT NULL,
	`clientName` varchar(100) NOT NULL,
	`redirectUris` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_oauth_clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `client_id_idx` UNIQUE(`clientId`)
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_codes` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`clientId` varchar(128) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`codeChallenge` varchar(64) NOT NULL,
	`redirectUri` varchar(512) NOT NULL,
	`resource` varchar(512) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_oauth_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `code_hash_idx` UNIQUE(`codeHash`)
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`clientId` varchar(128) NOT NULL,
	`familyId` varchar(15) NOT NULL,
	`resource` varchar(512) NOT NULL,
	`accessHash` varchar(64) NOT NULL,
	`refreshHash` varchar(64) NOT NULL,
	`accessExpiresAt` timestamp NOT NULL,
	`refreshExpiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mcp_oauth_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `access_hash_idx` UNIQUE(`accessHash`),
	CONSTRAINT `refresh_hash_idx` UNIQUE(`refreshHash`)
);
--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `mcp_oauth_codes` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `family_id_idx` ON `mcp_oauth_tokens` (`familyId`);--> statement-breakpoint
CREATE INDEX `refresh_expires_at_idx` ON `mcp_oauth_tokens` (`refreshExpiresAt`);--> statement-breakpoint
CREATE INDEX `owner_updated_id_idx` ON `videos` (`ownerId`,`updatedAt`,`id`);