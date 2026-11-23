/**
 * Type definitions for JSON metadata fields
 */

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	loomImportRun?: {
		runId: string;
		dispatch: "pending" | "accepted" | "rejected" | "uncertain";
		importPriority?: "customer" | "bulk";
		mediaDispatch?: {
			attemptId: string;
			videoId?: string;
			state: "accepted" | "rejected" | "uncertain";
			jobId?: string;
			worker?: "importer" | "media" | null;
		};
	};
	loomImportUpload?: {
		attemptId: string;
		ownerId: string;
		organizationId: string | null;
		source?: { key: string; uploadId: string };
		output: { key: string; uploadId: string };
	};
	loomDeferredProcessing?: {
		rawFileKey: string;
		status: "pending" | "started" | "complete";
		startedAt?: string;
	};
	transcribeOnView?: boolean;
	loomPreviewGif?: {
		status: "pending" | "started" | "complete";
		startedAt?: string;
	};
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
	/** The duration of the recording the editor edits, kept once a Save publishes a different length. */
	editorSourceDuration?: number;
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
	};
	/**
	 * A Save the owner's browser renders and uploads because the render farm
	 * can't take it. The share page shows its progress while it runs.
	 */
	webEditorBrowserSave?: {
		version: 1;
		saveId: string;
		status: "rendering" | "error" | "published";
		/** The `webEditorProject.savedAt` it renders. */
		projectSavedAt: string | null;
		progress: number;
		startedAt: string;
		updatedAt: string;
		publishedAt?: string;
		error?: string;
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
	desktopClient?: { version: string; gpui: boolean };
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
	/**
	 * Thumbnail the owner picked. `file` lives under
	 * `<ownerId>/<videoId>/thumbnail/` and changes with every pick.
	 */
	customThumbnail?: {
		file: string;
		source: "upload" | "frame";
		time?: number;
		updatedAt: string;
	};
}

export interface VideoCallToAction {
	label: string;
	url: string;
	headline?: string;
	color?: string;
	showWhilePlaying?: boolean;
}

export interface OrganizationDefaultCallToAction extends VideoCallToAction {
	enabledAt: string;
	includeExisting?: boolean;
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
