ALTER TABLE `mcp_oauth_clients` ADD `activatedAt` timestamp;--> statement-breakpoint
CREATE INDEX `inactive_created_at_idx` ON `mcp_oauth_clients` (`activatedAt`,`createdAt`);