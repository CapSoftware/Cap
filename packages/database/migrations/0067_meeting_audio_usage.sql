CREATE TABLE `meeting_audio_usage` (
	`userId` varchar(15) NOT NULL,
	`day` date NOT NULL,
	`units` int NOT NULL DEFAULT 0,
	CONSTRAINT `meeting_audio_usage_userId_day_pk` PRIMARY KEY(`userId`,`day`)
);
