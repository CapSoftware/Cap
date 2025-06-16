ALTER TABLE `spaces` ADD `primary` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `spaces` ADD `privacy` varchar(255) DEFAULT 'Private' NOT NULL;