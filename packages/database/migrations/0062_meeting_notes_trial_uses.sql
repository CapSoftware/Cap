CREATE TABLE `meeting_notes_trial_uses` (
	`userId` varchar(15) NOT NULL,
	`meetingId` varchar(64) NOT NULL,
	`createdAt` datetime NOT NULL,
	CONSTRAINT `meeting_notes_trial_uses_userId_meetingId_pk` PRIMARY KEY(`userId`,`meetingId`)
);
