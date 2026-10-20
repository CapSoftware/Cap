CREATE TABLE `organization_sso` (
	`organizationId` varchar(15) NOT NULL,
	`purchasedByUserId` varchar(15) NOT NULL,
	`stripeCustomerId` varchar(255),
	`stripeSubscriptionId` varchar(255),
	`stripePriceId` varchar(255),
	`status` varchar(32) NOT NULL DEFAULT 'unpaid',
	`paidThrough` datetime,
	`currentPeriodEnd` datetime,
	`cancelAtPeriodEnd` boolean NOT NULL DEFAULT false,
	`checkoutAttemptId` varchar(36),
	`checkoutCurrency` varchar(3),
	`checkoutPriceId` varchar(255),
	`checkoutSessionId` varchar(255),
	`checkoutStartedAt` datetime,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `organization_sso_organizationId` PRIMARY KEY(`organizationId`),
	CONSTRAINT `sso_stripe_subscription_id_idx` UNIQUE(`stripeSubscriptionId`)
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD CONSTRAINT `workos_organization_id_idx` UNIQUE(`workosOrganizationId`);