ALTER TABLE `auth_api_keys` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `auth_api_keys` ADD CONSTRAINT `auth_api_keys_id_unique` UNIQUE(`id`);