import {
	type DetectedDisplayRecordingMode,
	DISPLAY_SURFACE_TO_RECORDING_MODE,
} from "./web-recorder-constants";

export type { DetectedDisplayRecordingMode } from "./web-recorder-constants";

export type RecorderCapabilities = {
	assessed: boolean;
	hasMediaRecorder: boolean;
	hasUserMedia: boolean;
	hasDisplayMedia: boolean;
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
