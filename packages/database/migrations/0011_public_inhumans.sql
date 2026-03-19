CREATE TABLE `messenger_conversations` (
	`id` varchar(15) NOT NULL,
	`agent` varchar(32) NOT NULL,
	`mode` varchar(16) NOT NULL DEFAULT 'agent',
	`userId` varchar(15),
	`anonymousId` varchar(64),
	`takeoverByUserId` varchar(15),
	`takeoverAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastMessageAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messenger_conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `messenger_messages` (
	`id` varchar(15) NOT NULL,
	`conversationId` varchar(15) NOT NULL,
	`role` varchar(16) NOT NULL,
	`content` text NOT NULL,
	`userId` varchar(15),
	`anonymousId` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messenger_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `messenger_messages` ADD CONSTRAINT `messenger_messages_conversationId_messenger_conversations_id_fk` FOREIGN KEY (`conversationId`) REFERENCES `messenger_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_last_message_idx` ON `messenger_conversations` (`userId`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `anonymous_last_message_idx` ON `messenger_conversations` (`anonymousId`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `mode_last_message_idx` ON `messenger_conversations` (`mode`,`lastMessageAt`);--> statement-breakpoint
CREATE INDEX `updated_at_idx` ON `messenger_conversations` (`updatedAt`);--> statement-breakpoint
CREATE INDEX `conversation_created_at_idx` ON `messenger_messages` (`conversationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `role_created_at_idx` ON `messenger_messages` (`role`,`createdAt`);
