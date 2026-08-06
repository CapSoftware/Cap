CREATE TABLE `agent_api_operations` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`kind` varchar(32) NOT NULL,
	`resourceId` varchar(15) NOT NULL,
	`resultResourceId` varchar(15),
	`state` varchar(16) NOT NULL DEFAULT 'queued',
	`payload` json NOT NULL,
	`result` json,
	`errorCode` varchar(64),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` timestamp,
	CONSTRAINT `agent_api_operations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `agent_api_operations` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `state_updated_at_idx` ON `agent_api_operations` (`state`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `resource_id_idx` ON `agent_api_operations` (`resourceId`);