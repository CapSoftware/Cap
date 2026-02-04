/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
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
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	editorSavedRender?: {
		status: "QUEUED" | "PROCESSING" | "COMPLETE" | "ERROR";
		sourceKey: string;
		outputKey: string | null;
		progress: number;
		message: string | null;
		error: string | null;
		requestedAt: string;
		updatedAt: string;
	};
}

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
