UPDATE `auth_api_keys` SET `source` = 'unknown' WHERE `source` IS NULL;--> statement-breakpoint
ALTER TABLE `auth_api_keys` MODIFY COLUMN `source` varchar(32) NOT NULL DEFAULT 'unknown';
