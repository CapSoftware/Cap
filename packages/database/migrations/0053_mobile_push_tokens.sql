CREATE TABLE `mobile_push_claims` (
	`id` varchar(128) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mobile_push_claims_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mobile_push_tokens` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`token` varchar(200) NOT NULL,
	`sessionHash` varchar(64) NOT NULL,
	`environment` varchar(10) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `mobile_push_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `token_idx` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE INDEX `created_at_idx` ON `mobile_push_claims` (`createdAt`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `mobile_push_tokens` (`userId`);--> statement-breakpoint
CREATE INDEX `session_hash_idx` ON `mobile_push_tokens` (`sessionHash`);