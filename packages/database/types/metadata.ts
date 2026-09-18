/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	webEditorProject?:
		| {
				version: 1;
				config: Record<string, unknown>;
				savedAt: string;
		  }
		| {
				version: 2;
				configGzipBase64: string;
				uncompressedBytes: number;
				savedAt: string;
		  };
	webEditorAssets?: {
		version: 1;
		items: Array<{
			kind: "audio" | "image";
			key: string;
			path: string;
			name: string;
			contentType: string;
			size: number;
			objectIdentity: string | null;
		}>;
	};
	webEditorVideoUpload?: {
		version: 1;
		sessionId: string;
		key: string;
		path: string;
		fileName: string;
		size: number;
		contentType: string;
		uploadId: string;
		provider: "s3" | "googleDrive";
		bucketId: string | null;
		storageIntegrationId: string | null;
		expiresAt: string;
	};
	webEditorVideos?: {
		version: 1;
		items: Array<{
			key: string;
			path: string;
			name: string;
			contentType: string;
			size: number;
			objectIdentity: string | null;
		}>;
	};
	webEditorClips?: {
		version: 1;
		items: Array<{
			displayPath: string;
			duration: number;
			fps: number;
			hasAudio: boolean;
			cameraPath?: string;
			cameraFps?: number;
			cameraOffsetMs?: number;
		}>;
	};
	webEditorImports?: {
		version: 1;
		items: Array<
			| { kind: "clip"; path: string }
			| { kind: "cap"; path: string; clipCount: number }
		>;
	};
	webEditorCaptionJob?: {
		status: "processing" | "error";
		requestId: string;
		sourceHash: string;
		requestedAt: string;
	};
	editorSources?: {
		version: 1;
		display: {
			key: string;
			contentType: "video/webm" | "video/mp4";
			size?: number;
			fps?: number;
			objectIdentity?: string | null;
		};
		camera?: {
			key: string;
			contentType: "video/webm" | "video/mp4";
			size: number;
			fps?: number;
			objectIdentity: string | null;
			offsetMs: number;
		};
	};
	editProcessing?: {
		token: string;
		startedAt: string;
		ownerId: string;
		bucket: string | null;
		storageIntegrationId: string | null;
		sourceKey: string;
		source: string;
		dispatch: "pending" | "dispatching" | "accepted";
		jobId?: string;
		resultCommitted?: boolean;
		renderedMetadata?: {
			duration: number;
			width: number;
			height: number;
			fps: number;
		};
	};
	completedVideoEdit?: {
		token: string;
		startedAt: string;
		transcriptRemapped: boolean;
	};
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
		outputKey?: string;
		outputSha256?: string;
		sourceObjectIdentity?: string;
		sourceProof?: {
			version: 1;
			manifestSha256: string;
			inventorySha256: string;
			sourcePreserved: true;
			videoDuration: number;
			hasAudio: boolean;
			audioVerified: boolean;
		};
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
	summaryManuallyEdited?: boolean;
	/**
	 * Chapter markers generated from the transcript
	 */
	chapters?: { title: string; start: number }[];
	chaptersManuallyEdited?: boolean;
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
