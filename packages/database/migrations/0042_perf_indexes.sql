CREATE INDEX `id_idx` ON `imported_videos` (`id`);--> statement-breakpoint
CREATE INDEX `integration_object_key_prefix_idx` ON `storage_objects` (`integrationId`,`objectKey`(191));--> statement-breakpoint
CREATE INDEX `screenshot_transcription_created_idx` ON `videos` (`isScreenshot`,`transcriptionStatus`,`createdAt`);