CREATE TABLE `auth_challenges` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15),
	`purpose` varchar(32) NOT NULL,
	`secretHash` varchar(64) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`expiresAt` datetime NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auth_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_hash_idx` UNIQUE(`secretHash`)
);
--> statement-breakpoint
CREATE TABLE `user_passkeys` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`credentialId` varchar(1400) NOT NULL,
	`credentialIdHash` varchar(64) NOT NULL,
	`publicKey` text NOT NULL,
	`counter` bigint unsigned NOT NULL DEFAULT 0,
	`transports` json,
	`deviceType` varchar(32) NOT NULL,
	`backedUp` boolean NOT NULL DEFAULT false,
	`aaguid` varchar(36),
	`name` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastUsedAt` timestamp,
	CONSTRAINT `user_passkeys_id` PRIMARY KEY(`id`),
	CONSTRAINT `credential_id_hash_idx` UNIQUE(`credentialIdHash`)
);
--> statement-breakpoint
CREATE INDEX `user_purpose_idx` ON `auth_challenges` (`userId`,`purpose`);--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `auth_challenges` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `user_passkeys` (`userId`);