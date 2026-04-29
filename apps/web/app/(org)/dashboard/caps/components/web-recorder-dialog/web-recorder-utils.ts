import {
	type DetectedDisplayRecordingMode,
	DISPLAY_SURFACE_TO_RECORDING_MODE,
	MP4_MIME_TYPES,
	WEBM_MIME_TYPES,
} from "./web-recorder-constants";

export type { DetectedDisplayRecordingMode } from "./web-recorder-constants";

export type RecorderCapabilities = {
	assessed: boolean;
	hasMediaRecorder: boolean;
	hasUserMedia: boolean;
	hasDisplayMedia: boolean;
};

type RecorderEnvironment = {
	userAgent?: string;
	brands?: Array<{ brand: string }>;
};

export type RecordingPipeline =
	| {
			mode: "streaming-webm";
			mimeType: string;
			fileExtension: "webm";
			supportsProgressiveUpload: true;
	  }
	| {
			mode: "buffered-raw";
			mimeType: string;
			fileExtension: "webm" | "mp4";
			supportsProgressiveUpload: false;
	  };

export const detectCapabilities = (): RecorderCapabilities => {
	if (typeof window === "undefined" || typeof navigator === "undefined") {
		return {
			assessed: false,
			hasMediaRecorder: false,
			hasUserMedia: false,
			hasDisplayMedia: false,
		};
	}

	const mediaDevices = navigator.mediaDevices;

	return {
		assessed: true,
		hasMediaRecorder: typeof MediaRecorder !== "undefined",
		hasUserMedia: typeof mediaDevices?.getUserMedia === "function",
		hasDisplayMedia: typeof mediaDevices?.getDisplayMedia === "function",
	};
};

export const detectRecordingModeFromTrack = (
	track: MediaStreamTrack | null,
	settings?: MediaTrackSettings,
): DetectedDisplayRecordingMode | null => {
	if (!track) return null;

	const trackSettings = settings ?? track.getSettings();
	const maybeDisplaySurface = (
		trackSettings as Partial<{ displaySurface?: unknown }>
	).displaySurface;
	const rawSurface =
		typeof maybeDisplaySurface === "string" ? maybeDisplaySurface : "";
	const normalizedSurface = rawSurface.toLowerCase();

	if (normalizedSurface) {
		const mapped = DISPLAY_SURFACE_TO_RECORDING_MODE[normalizedSurface];
		if (mapped) {
			return mapped;
		}
	}

	const label = track.label?.toLowerCase() ?? "";

	if (
		label.includes("screen") ||
		label.includes("display") ||
		label.includes("monitor")
	) {
		return "fullscreen";
	}

	if (label.includes("window") || label.includes("application")) {
		return "window";
	}

	if (label.includes("tab") || label.includes("browser")) {
		return "tab";
	}

	return null;
};

export const pickSupportedMimeType = (candidates: readonly string[]) => {
	if (typeof MediaRecorder === "undefined") return undefined;
	return candidates.find((candidate) =>
		MediaRecorder.isTypeSupported(candidate),
	);
};

export const shouldPreferStreamingUpload = (
	environment: RecorderEnvironment = {},
) => {
	const userAgent = environment.userAgent ?? "";
	const brandMatch =
		environment.brands?.some(({ brand }) =>
			/(chromium|google chrome|microsoft edge|opera)/i.test(brand),
		) ?? false;

	if (/(ipad|iphone|ipod)/i.test(userAgent)) {
		return false;
	}

	if (/firefox/i.test(userAgent)) {
		return false;
	}

	if (
		/safari/i.test(userAgent) &&
		!/(chrome|chromium|edg|opr|opera)/i.test(userAgent)
	) {
		return false;
	}

	return brandMatch || /(chrome|chromium|edg|opr|opera|brave)/i.test(userAgent);
};

export const openShareUrlInNewTab = (shareUrl?: string | null) => {
	if (!shareUrl || typeof window === "undefined") {
		return false;
	}

	return window.open(shareUrl, "_blank", "noopener,noreferrer") !== null;
};

export const selectRecordingPipelineFromSupport = (
	hasAudio: boolean,
	isMimeSupported: (candidate: string) => boolean,
	options?: {
		preferStreamingUpload?: boolean;
	},
): RecordingPipeline | null => {
	const webmCandidates = hasAudio
		? [...WEBM_MIME_TYPES.withAudio, ...WEBM_MIME_TYPES.videoOnly]
		: [...WEBM_MIME_TYPES.videoOnly, ...WEBM_MIME_TYPES.withAudio];
	const fallbackCandidates = hasAudio
		? [...MP4_MIME_TYPES.withAudio, ...MP4_MIME_TYPES.videoOnly]
		: [...MP4_MIME_TYPES.videoOnly, ...MP4_MIME_TYPES.withAudio];
	const supportedWebmMimeType = webmCandidates.find((candidate) =>
		isMimeSupported(candidate),
	);
	const supportedFallbackMimeType = fallbackCandidates.find((candidate) =>
		isMimeSupported(candidate),
	);

	if (supportedWebmMimeType && options?.preferStreamingUpload !== false) {
		return {
			mode: "streaming-webm",
			mimeType: supportedWebmMimeType,
			fileExtension: "webm",
			supportsProgressiveUpload: true,
		};
	}

	if (supportedFallbackMimeType) {
		return {
			mode: "buffered-raw",
			mimeType: supportedFallbackMimeType,
			fileExtension: supportedFallbackMimeType.includes("webm")
				? "webm"
				: "mp4",
			supportsProgressiveUpload: false,
		};
	}

	if (supportedWebmMimeType) {
		return {
			mode: "buffered-raw",
			mimeType: supportedWebmMimeType,
			fileExtension: "webm",
			supportsProgressiveUpload: false,
		};
	}

	return null;
};

export const selectRecordingPipeline = (
	hasAudio: boolean,
): RecordingPipeline | null => {
	if (typeof MediaRecorder === "undefined") {
		return null;
	}

	const userAgent =
		typeof navigator === "undefined" ? undefined : navigator.userAgent;
	const navigatorWithUserAgentData =
		typeof navigator === "undefined"
			? undefined
			: (navigator as Navigator & {
					userAgentData?: { brands?: Array<{ brand: string }> };
				});
	const brands =
		!navigatorWithUserAgentData ||
		!("userAgentData" in navigatorWithUserAgentData)
			? undefined
			: navigatorWithUserAgentData.userAgentData?.brands;

	return selectRecordingPipelineFromSupport(
		hasAudio,
		(candidate) => MediaRecorder.isTypeSupported(candidate),
		{
			preferStreamingUpload: shouldPreferStreamingUpload({
				userAgent,
				brands,
			}),
		},
	);
};

export const isUserCancellationError = (error: unknown): boolean => {
	if (!(error instanceof DOMException)) return false;
	return error.name === "NotAllowedError" || error.name === "AbortError";
};

export const shouldRetryDisplayMediaWithoutPreferences = (error: unknown) => {
	if (isUserCancellationError(error)) return false;

	if (error instanceof DOMException) {
		return (
			error.name === "OverconstrainedError" ||
			error.name === "NotSupportedError" ||
			error.name === "InvalidAccessError"
		);
	}

	return error instanceof TypeError;
};
