CREATE TABLE `auto_mode_sessions` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`orgId` varchar(15) NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'draft',
	`prompt` text NOT NULL,
	`targetUrl` varchar(2048),
	`scrapedContext` json,
	`questionnaire` json,
	`generatedPlan` json,
	`ttsAudioUrl` varchar(2048),
	`executionLog` json,
	`resultVideoId` varchar(15),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `auto_mode_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `auto_mode_sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `org_id_idx` ON `auto_mode_sessions` (`orgId`);--> statement-breakpoint
CREATE INDEX `status_idx` ON `auto_mode_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `user_org_status_idx` ON `auto_mode_sessions` (`userId`,`orgId`,`status`);--> statement-breakpoint
CREATE INDEX `created_at_idx` ON `auto_mode_sessions` (`createdAt`);