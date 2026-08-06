import {
	DISPLAY_MEDIA_VIDEO_CONSTRAINTS,
	DISPLAY_MODE_PREFERENCES,
	type ExtendedDisplayMediaStreamOptions,
	isUserCancellationError,
	shouldRetryDisplayMediaWithoutPreferences,
} from "@cap/recorder-core";
import type { RecordingMode } from "../shared/types";

export type DisplayMediaRequester = (
	options: Partial<ExtendedDisplayMediaStreamOptions>,
) => Promise<MediaStream>;

type CaptureAttempt =
	| { ok: true; stream: MediaStream }
	| { ok: false; error: unknown; rejectedBeforeNextTask: boolean };

const captureOnce = async (
	requestDisplayMedia: DisplayMediaRequester,
	options: Partial<ExtendedDisplayMediaStreamOptions>,
): Promise<CaptureAttempt> => {
	let nextTaskStarted = false;
	const taskMarker = globalThis.setTimeout(() => {
		nextTaskStarted = true;
	}, 0);

	try {
		return { ok: true, stream: await requestDisplayMedia(options) };
	} catch (error) {
		return {
			ok: false,
			error,
			rejectedBeforeNextTask: !nextTaskStarted,
		};
	} finally {
		globalThis.clearTimeout(taskMarker);
	}
};

const canRetryWithoutShowingAnotherPicker = (attempt: CaptureAttempt) =>
	!attempt.ok &&
	attempt.rejectedBeforeNextTask &&
	!isUserCancellationError(attempt.error) &&
	shouldRetryDisplayMediaWithoutPreferences(attempt.error);

export const captureDisplayStream = async (
	mode: Exclude<RecordingMode, "tab" | "camera">,
	includeAudio: boolean,
	requestDisplayMedia: DisplayMediaRequester,
) => {
	const video = DISPLAY_MEDIA_VIDEO_CONSTRAINTS;
	const preferredAttempt = await captureOnce(requestDisplayMedia, {
		...DISPLAY_MODE_PREFERENCES[mode],
		video,
		audio: includeAudio,
	});
	if (preferredAttempt.ok) return preferredAttempt.stream;
	if (!canRetryWithoutShowingAnotherPicker(preferredAttempt)) {
		throw preferredAttempt.error;
	}

	const compatibleAttempt = await captureOnce(requestDisplayMedia, {
		video,
		audio: includeAudio,
	});
	if (compatibleAttempt.ok) return compatibleAttempt.stream;
	if (
		!includeAudio ||
		!canRetryWithoutShowingAnotherPicker(compatibleAttempt)
	) {
		throw compatibleAttempt.error;
	}

	const videoOnlyAttempt = await captureOnce(requestDisplayMedia, {
		video,
		audio: false,
	});
	if (videoOnlyAttempt.ok) return videoOnlyAttempt.stream;
	throw videoOnlyAttempt.error;
};
