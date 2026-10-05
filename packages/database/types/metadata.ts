/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	/** Imported from an audio file: the video is a title card the editor hides. */
	audioOnly?: boolean;
	/** Camera placement chosen in the browser recorder, applied to the project. */
	recorderCamera?: {
		version: 1;
		position: {
			x: "left" | "center" | "right";
			y: "top" | "bottom";
		};
		size: number;
		mirror: boolean;
		shape: "round" | "square" | "full";
	};
	webEditorAudioDefault?: {
		enabledByDefault: boolean;
		isolation: "light" | "balanced" | "strong";
	};
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
			/** An imported video's own audio, which the editor plays with it. */
			embeddedAudio?: true;
		};
		camera?: {
			key: string;
			contentType: "video/webm" | "video/mp4";
			size: number;
			fps?: number;
			objectIdentity: string | null;
			offsetMs: number;
		};
		mic?: {
			key: string;
			contentType: "audio/webm" | "audio/mp4";
			size: number;
			objectIdentity: string | null;
			offsetMs: number;
		};
		systemAudio?: {
			key: string;
			contentType: "audio/webm" | "audio/mp4";
			size: number;
			objectIdentity: string | null;
			offsetMs: number;
		};
		inputEvents?: {
			key: string;
			contentType: "application/x-ndjson";
			size: number;
			objectIdentity: string | null;
		};
	};
	/**
	 * Experimental cursor replacement for browser recordings: a render farm job
	 * removes the recorded cursor from the display and reconstructs its path,
	 * which the editor draws as a Studio cursor while `enabled`.
	 */
	cursorReconstruction?: {
		version: 1;
		runId: string;
		/** Empty until the render farm accepts the job. */
		jobId: string;
		status: "processing" | "ready" | "error";
		enabled: boolean;
		/** The display source the job reads; a new recording invalidates it. */
		sourceKey: string;
		sourceSize?: number;
		sourceIdentity?: string | null;
		startedAt: string;
		progress?: number;
		completedAt?: string;
		error?: string;
		display?: { key: string; size: number };
		inputEvents?: { key: string; size: number };
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
	renderFarmSave?: {
		version: 1;
		exportId: string;
		/** Empty while a render started on recording completion is being prepared. */
		jobId: string;
		status: "rendering" | "error" | "published";
		/** Absent for editor saves; "recording" renders the finished upload. */
		trigger?: "recording";
		/** The `webEditorProject.savedAt` it renders, null for the recording as recorded. */
		projectSavedAt?: string | null;
		startedAt: string;
		outputKey: string;
		hlsPrefix: string;
		error?: string;
		publishedAt?: string;
		/** Rendered and uploaded by this editor worker session instead of the farm. */
		worker?: { sessionPath: string };
	};
	/** Set by the browser-rendered Saves Cap no longer makes: the video was saved from the web editor. */
	publishedBrowserSaveId?: string | null;
	renderFarmExports?: {
		version: 1;
		items: {
			exportId: string;
			jobId: string;
			status: "rendering" | "ready" | "error";
			startedAt: string;
			outputKey: string;
			fileName: string;
			resolution: [number, number];
			fps: number;
			bytes?: number;
			completedAt?: string;
			emailedAt?: string;
			error?: string;
		}[];
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
	/**
	 * The owner's own title, description and image for the share link's
	 * preview when it is pasted into chat apps and social sites. Setting it
	 * needs Cap Pro; a downgraded owner keeps what they set but can only reset it.
	 */
	linkPreview?: {
		version: 1;
		title?: string;
		description?: string;
		/** Stored in Cap's default bucket under `link-previews/<videoId>/`. */
		image?: {
			key: string;
			width: number;
			height: number;
			contentType: "image/jpeg" | "image/png";
			size: number;
		};
		updatedAt: string;
	};
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	agentUpload?: {
		state: "pending" | "accepted" | "rejected";
		rawFileKey?: string;
	};
}

export interface VideoCallToAction {
	label: string;
	url: string;
	headline?: string;
	color?: string;
	showWhilePlaying?: boolean;
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
