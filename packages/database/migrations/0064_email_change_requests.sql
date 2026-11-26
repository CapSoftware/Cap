CREATE TABLE `email_change_requests` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`newEmail` varchar(255) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`expiresAt` datetime NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_change_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `email_change_requests` (`userId`);--> statement-breakpoint
CREATE INDEX `expires_at_idx` ON `email_change_requests` (`expiresAt`);