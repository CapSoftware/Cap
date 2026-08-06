CREATE TABLE `messenger_support_emails` (
	`id` varchar(15) NOT NULL,
	`conversationId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`userEmail` varchar(255) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messenger_support_emails_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `messenger_support_emails` ADD CONSTRAINT `support_email_conversation_fk` FOREIGN KEY (`conversationId`) REFERENCES `messenger_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `support_email_user_created_at_idx` ON `messenger_support_emails` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `support_email_conversation_created_at_idx` ON `messenger_support_emails` (`conversationId`,`createdAt`);