ALTER TABLE `comments` ADD `mediaKey` varchar(512);--> statement-breakpoint
ALTER TABLE `comments` ADD `mediaDuration` float;--> statement-breakpoint
ALTER TABLE `comments` ADD `mediaMeta` json;