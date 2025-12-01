ALTER TABLE `organizations` ADD `stripeCustomerId` varchar(255);--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripeSubscriptionId` varchar(255);--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripeSubscriptionStatus` varchar(255);--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripeSubscriptionPriceId` varchar(255);--> statement-breakpoint
ALTER TABLE `organizations` ADD `paidSeats` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `organization_members` ADD `seatType` varchar(255) NOT NULL DEFAULT 'free';
