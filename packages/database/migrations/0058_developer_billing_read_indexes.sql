CREATE INDEX `auto_top_up_idx` ON `developer_credit_accounts` (`autoTopUpEnabled`);--> statement-breakpoint
CREATE INDEX `reference_type_id_idx` ON `developer_credit_transactions` (`referenceType`,`referenceId`);--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_completed_idx` ON `developer_transcripts` (`appId`,`status`,`completedAt`,`durationSeconds`,`billedMicroCredits`);--> statement-breakpoint
CREATE INDEX `dev_transcripts_app_status_held_idx` ON `developer_transcripts` (`appId`,`status`,`createdAt`,`deletedAt`,`reservedMicroCredits`);