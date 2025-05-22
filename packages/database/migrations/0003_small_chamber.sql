CREATE TABLE `auth_api_keys` (
	`id` varchar(36) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now())
);
