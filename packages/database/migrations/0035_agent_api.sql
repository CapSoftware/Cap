CREATE TABLE `agent_api_authorization_codes` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`codeChallenge` varchar(64) NOT NULL,
	`redirectUri` varchar(512) NOT NULL,
	`scopes` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`consumedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_api_authorization_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `code_hash_idx` UNIQUE(`codeHash`)
);
--> statement-breakpoint
CREATE TABLE `agent_api_idempotency` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`operation` varchar(64) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'pending',
	`statusCode` int,
	`response` json,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_api_idempotency_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_operation_key_idx` UNIQUE(`userId`,`operation`,`keyHash`)
);
--> statement-breakpoint
CREATE TABLE `agent_api_keys` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`name` varchar(100) NOT NULL DEFAULT 'Cap CLI',
	`scopes` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp,
	CONSTRAINT `agent_api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_hash_idx` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `agent_api_authorization_codes` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `agent_api_authorization_codes` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `agent_api_idempotency` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `agent_api_keys` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `agent_api_keys` (`expiresAt`);