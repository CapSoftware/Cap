/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	desktopRecordingUpload?: {
		version: 1;
		artifact:
			| { kind: "segments"; manifestSha256: string }
			| {
					kind: "mp4";
					fileSize: number;
					duration: number;
					objectIdentity: string;
			  };
		fileSize: number;
		duration: number;
		hasAudio: boolean;
		fullDecode: true;
		requiredAudioVerified?: boolean;
		objectIdentity: string;
	};
	/**
	 * Custom created date that can be edited by the user
	 * This overrides the display of the actual createdAt timestamp
	 */
	customCreatedAt?: string;
	/**
	 * Title of the captured monitor or window
	 */
	sourceName?: string;
	/**
	 * AI generated title for the video
	 */
	aiTitle?: string;
	titleManuallyEdited?: boolean;
	/**
	 * AI generated summary of the content
	 */
	summary?: string;
	/**
	 * Chapter markers generated from the transcript
	 */
	chapters?: { title: string; start: number }[];
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	/**
	 * Progress of the provisional live transcription that runs while an
	 * instant-mode recording is still uploading. The transcript content lives
	 * in `transcription.live.json` next to the video; this only gates UI/queue
	 * behavior. Cleared when the canonical transcription completes.
	 */
	liveTranscript?: {
		status: "active" | "complete" | "stopped";
		updatedAt?: string;
	};
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	agentUpload?: {
		state: "pending" | "accepted" | "rejected";
		rawFileKey?: string;
	};
}

export type VideoEditRange = {
	start: number;
	end: number;
};

export type VideoEditSpec = {
	version: 1;
	sourceDuration: number;
	keepRanges: VideoEditRange[];
};

/**
 * Space metadata structure
 */
export interface SpaceMetadata {
	[key: string]: never;
}

/**
 * User metadata structure
 */
export interface UserMetadata {
	[key: string]: never;
}
