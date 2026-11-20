CREATE TABLE `meeting_notes_trial_uses` (
	`userId` varchar(15) NOT NULL,
	`meetingId` varchar(64) NOT NULL,
	`slot` int NOT NULL,
	`notesRuns` int NOT NULL DEFAULT 1,
	`askRuns` int NOT NULL DEFAULT 0,
	`startedAt` datetime NOT NULL,
	`completedAt` datetime,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `meeting_notes_trial_uses_userId_meetingId_pk` PRIMARY KEY(`userId`,`meetingId`),
	CONSTRAINT `user_slot_idx` UNIQUE(`userId`,`slot`)
);
