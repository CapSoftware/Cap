CREATE TABLE `accounts` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`type` varchar(255) NOT NULL,
	`provider` varchar(255) NOT NULL,
	`providerAccountId` varchar(255) NOT NULL,
	`access_token` text,
	`expires_in` int,
	`id_token` text,
	`refresh_token` text,
	`refresh_token_expires_in` int,
	`scope` varchar(255),
	`token_type` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`tempColumn` text,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `accounts_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` varchar(15) NOT NULL,
	`type` varchar(6) NOT NULL,
	`content` text NOT NULL,
	`timestamp` float,
	`authorId` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`parentCommentId` varchar(15),
	CONSTRAINT `comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `comments_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `s3_buckets` (
	`id` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`region` text NOT NULL,
	`endpoint` text,
	`bucketName` text NOT NULL,
	`accessKeyId` text NOT NULL,
	`secretAccessKey` text NOT NULL,
	`provider` text NOT NULL DEFAULT ('aws'),
	CONSTRAINT `s3_buckets_id` PRIMARY KEY(`id`),
	CONSTRAINT `s3_buckets_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(15) NOT NULL,
	`sessionToken` varchar(255) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`expires` datetime NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_id_unique` UNIQUE(`id`),
	CONSTRAINT `sessions_sessionToken_unique` UNIQUE(`sessionToken`),
	CONSTRAINT `session_token_idx` UNIQUE(`sessionToken`)
);
--> statement-breakpoint
CREATE TABLE `shared_videos` (
	`id` varchar(15) NOT NULL,
	`videoId` varchar(15) NOT NULL,
	`spaceId` varchar(15) NOT NULL,
	`sharedByUserId` varchar(15) NOT NULL,
	`sharedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `shared_videos_id` PRIMARY KEY(`id`),
	CONSTRAINT `shared_videos_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `space_invites` (
	`id` varchar(15) NOT NULL,
	`spaceId` varchar(15) NOT NULL,
	`invitedEmail` varchar(255) NOT NULL,
	`invitedByUserId` varchar(15) NOT NULL,
	`role` varchar(255) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`expiresAt` timestamp,
	CONSTRAINT `space_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `space_invites_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `space_members` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`spaceId` varchar(15) NOT NULL,
	`role` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `space_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `space_members_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` varchar(15) NOT NULL,
	`name` varchar(255) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`metadata` json,
	`allowedEmailDomain` varchar(255),
	`customDomain` varchar(255),
	`domainVerified` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`workosOrganizationId` varchar(255),
	`workosConnectionId` varchar(255),
	CONSTRAINT `spaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `spaces_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(15) NOT NULL,
	`name` varchar(255),
	`lastName` varchar(255),
	`email` varchar(255) NOT NULL,
	`emailVerified` timestamp,
	`image` varchar(255),
	`stripeCustomerId` varchar(255),
	`stripeSubscriptionId` varchar(255),
	`thirdPartyStripeSubscriptionId` varchar(255),
	`stripeSubscriptionStatus` varchar(255),
	`stripeSubscriptionPriceId` varchar(255),
	`activeSpaceId` varchar(15),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`onboarding_completed_at` timestamp,
	`customBucket` varchar(15),
	`inviteQuota` int NOT NULL DEFAULT 1,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_id_unique` UNIQUE(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `email_idx` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `verification_tokens` (
	`identifier` varchar(255) NOT NULL,
	`token` varchar(255) NOT NULL,
	`expires` datetime NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `verification_tokens_identifier` PRIMARY KEY(`identifier`),
	CONSTRAINT `verification_tokens_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` varchar(15) NOT NULL,
	`ownerId` varchar(15) NOT NULL,
	`name` varchar(255) NOT NULL DEFAULT 'My Video',
	`awsRegion` varchar(255),
	`awsBucket` varchar(255),
	`bucket` varchar(15),
	`metadata` json,
	`public` boolean NOT NULL DEFAULT true,
	`videoStartTime` varchar(255),
	`audioStartTime` varchar(255),
	`xStreamInfo` text,
	`jobId` varchar(255),
	`jobStatus` varchar(255),
	`isScreenshot` boolean NOT NULL DEFAULT false,
	`skipProcessing` boolean NOT NULL DEFAULT false,
	`transcriptionStatus` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`source` json NOT NULL DEFAULT ('{"type":"MediaConvert"}'),
	CONSTRAINT `videos_id` PRIMARY KEY(`id`),
	CONSTRAINT `videos_id_unique` UNIQUE(`id`)
);
--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `provider_account_id_idx` ON `accounts` (`providerAccountId`);--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `comments` (`videoId`);--> statement-breakpoint
CREATE INDEX `author_id_idx` ON `comments` (`authorId`);--> statement-breakpoint
CREATE INDEX `parent_comment_id_idx` ON `comments` (`parentCommentId`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `video_id_idx` ON `shared_videos` (`videoId`);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `shared_videos` (`spaceId`);--> statement-breakpoint
CREATE INDEX `shared_by_user_id_idx` ON `shared_videos` (`sharedByUserId`);--> statement-breakpoint
CREATE INDEX `video_id_space_id_idx` ON `shared_videos` (`videoId`,`spaceId`);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `space_invites` (`spaceId`);--> statement-breakpoint
CREATE INDEX `invited_email_idx` ON `space_invites` (`invitedEmail`);--> statement-breakpoint
CREATE INDEX `invited_by_user_id_idx` ON `space_invites` (`invitedByUserId`);--> statement-breakpoint
CREATE INDEX `status_idx` ON `space_invites` (`status`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `space_members` (`userId`);--> statement-breakpoint
CREATE INDEX `space_id_idx` ON `space_members` (`spaceId`);--> statement-breakpoint
CREATE INDEX `user_id_space_id_idx` ON `space_members` (`userId`,`spaceId`);--> statement-breakpoint
CREATE INDEX `owner_id_idx` ON `spaces` (`ownerId`);--> statement-breakpoint
CREATE INDEX `custom_domain_idx` ON `spaces` (`customDomain`);--> statement-breakpoint
CREATE INDEX `id_idx` ON `videos` (`id`);--> statement-breakpoint
CREATE INDEX `owner_id_idx` ON `videos` (`ownerId`);--> statement-breakpoint
CREATE INDEX `is_public_idx` ON `videos` (`public`);
