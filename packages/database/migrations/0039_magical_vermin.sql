CREATE TABLE `signed_baas` (
	`id` varchar(15) NOT NULL,
	`organizationId` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'pending',
	`stripeSubscriptionId` varchar(255),
	`entityName` varchar(255) NOT NULL,
	`entityType` varchar(255) NOT NULL,
	`entityAddress` varchar(500) NOT NULL,
	`signerName` varchar(255) NOT NULL,
	`signerTitle` varchar(255) NOT NULL,
	`noticesEmail` varchar(255) NOT NULL,
	`signatureData` longtext NOT NULL,
	`signedAt` timestamp,
	`emailSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `signed_baas_id` PRIMARY KEY(`id`),
	CONSTRAINT `signed_baa_organization_id_idx` UNIQUE(`organizationId`)
);
--> statement-breakpoint
CREATE INDEX `signed_baa_stripe_subscription_idx` ON `signed_baas` (`stripeSubscriptionId`);