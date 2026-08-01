CREATE TABLE `product_analytics_erasure_requests` (
	`id` varchar(36) NOT NULL,
	`scopeHash` varchar(64) NOT NULL,
	`userId` varchar(255),
	`organizationId` varchar(255),
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`attemptCount` int NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp NOT NULL DEFAULT (now()),
	`leaseOwnerId` varchar(36),
	`leaseExpiresAt` timestamp,
	`lastErrorCode` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_erasure_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `scope_hash_idx` UNIQUE(`scopeHash`)
);
--> statement-breakpoint
CREATE TABLE `product_analytics_event_receipts` (
	`eventIdHash` varchar(64) NOT NULL,
	`payloadHash` varchar(32) NOT NULL,
	`anonymousIdentityHash` varchar(64),
	`userIdentityHash` varchar(64),
	`organizationIdentityHash` varchar(64),
	`conflictCount` int NOT NULL DEFAULT 0,
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`retainUntil` timestamp NOT NULL,
	CONSTRAINT `product_analytics_event_receipts_eventIdHash` PRIMARY KEY(`eventIdHash`)
);
--> statement-breakpoint
CREATE TABLE `product_analytics_identity_links` (
	`anonymousIdentityHash` varchar(64) NOT NULL,
	`userIdentityHash` varchar(64) NOT NULL,
	`organizationIdentityHash` varchar(64),
	`anonymousId` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `identity_link_pk` PRIMARY KEY(`anonymousIdentityHash`,`userIdentityHash`)
);
--> statement-breakpoint
CREATE TABLE `product_analytics_identity_state` (
	`identityHash` varchar(64) NOT NULL,
	`identityKind` varchar(16) NOT NULL,
	`blockedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_identity_state_identityHash` PRIMARY KEY(`identityHash`)
);
--> statement-breakpoint
CREATE TABLE `product_analytics_ingestion_leases` (
	`id` varchar(36) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `product_analytics_ingestion_leases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_analytics_outbox` (
	`eventId` varchar(128) NOT NULL,
	`deliveryKey` varchar(36) NOT NULL,
	`payloadHash` varchar(32) NOT NULL,
	`eventName` varchar(64) NOT NULL,
	`payloadKind` varchar(32) NOT NULL DEFAULT 'product_event_row_v1',
	`payload` json NOT NULL,
	`anonymousId` varchar(255),
	`userId` varchar(255),
	`organizationId` varchar(255),
	`status` varchar(32) NOT NULL DEFAULT 'pending',
	`attemptCount` int NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp NOT NULL DEFAULT (now()),
	`leaseOwnerId` varchar(64),
	`leaseExpiresAt` timestamp,
	`workflowRunId` varchar(128),
	`payloadConflict` boolean NOT NULL DEFAULT false,
	`lastErrorCode` varchar(64),
	`deliveredAt` timestamp,
	`deadLetteredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `product_analytics_outbox_eventId` PRIMARY KEY(`eventId`),
	CONSTRAINT `delivery_key_idx` UNIQUE(`deliveryKey`)
);
--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `invitedEmailNormalized` varchar(255);--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryState` varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryAttemptCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryNextAttemptAt` timestamp;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryErrorCode` varchar(64);--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryLeaseOwnerId` varchar(36);--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailDeliveryLeaseExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailProviderMessageId` varchar(255);--> statement-breakpoint
ALTER TABLE `organization_invites` ADD `emailSentAt` timestamp;--> statement-breakpoint
ALTER TABLE `organization_invites` ADD CONSTRAINT `normalized_email_idx` UNIQUE(`organizationId`,`invitedEmailNormalized`);--> statement-breakpoint
CREATE INDEX `queue_idx` ON `product_analytics_erasure_requests` (`status`,`nextAttemptAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `lease_idx` ON `product_analytics_erasure_requests` (`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `anonymous_identity_idx` ON `product_analytics_event_receipts` (`anonymousIdentityHash`);--> statement-breakpoint
CREATE INDEX `user_identity_idx` ON `product_analytics_event_receipts` (`userIdentityHash`);--> statement-breakpoint
CREATE INDEX `organization_identity_idx` ON `product_analytics_event_receipts` (`organizationIdentityHash`);--> statement-breakpoint
CREATE INDEX `retention_idx` ON `product_analytics_event_receipts` (`retainUntil`);--> statement-breakpoint
CREATE INDEX `conflict_idx` ON `product_analytics_event_receipts` (`conflictCount`);--> statement-breakpoint
CREATE INDEX `user_identity_idx` ON `product_analytics_identity_links` (`userIdentityHash`);--> statement-breakpoint
CREATE INDEX `organization_identity_idx` ON `product_analytics_identity_links` (`organizationIdentityHash`);--> statement-breakpoint
CREATE INDEX `blocked_idx` ON `product_analytics_identity_state` (`blockedAt`);--> statement-breakpoint
CREATE INDEX `expiry_idx` ON `product_analytics_ingestion_leases` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `delivery_idx` ON `product_analytics_outbox` (`status`,`nextAttemptAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `lease_idx` ON `product_analytics_outbox` (`leaseExpiresAt`);--> statement-breakpoint
CREATE INDEX `retention_idx` ON `product_analytics_outbox` (`status`,`deliveredAt`);--> statement-breakpoint
CREATE INDEX `user_id_idx` ON `product_analytics_outbox` (`userId`);--> statement-breakpoint
CREATE INDEX `organization_id_idx` ON `product_analytics_outbox` (`organizationId`);--> statement-breakpoint
CREATE INDEX `anonymous_id_idx` ON `product_analytics_outbox` (`anonymousId`);--> statement-breakpoint
CREATE INDEX `email_delivery_idx` ON `organization_invites` (`emailDeliveryState`,`emailDeliveryNextAttemptAt`);