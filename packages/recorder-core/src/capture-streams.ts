import {
	type DetectedDisplayRecordingMode,
	DISPLAY_MEDIA_VIDEO_CONSTRAINTS,
	DISPLAY_MODE_PREFERENCES,
	type DisplaySurfacePreference,
	type ExtendedDisplayMediaStreamOptions,
	RECORDING_MODE_TO_DISPLAY_SURFACE,
} from "./recorder-constants";
import {
	isUserCancellationError,
	shouldRetryDisplayMediaWithoutPreferences,
} from "./recorder-utils";

/**
 * The capture half of the web recording engine: device acquisition with the
 * retry ladders and the audio mix graph, shared by the dashboard web recorder
 * and the share-page comment recorders so every surface records through the
 * same code path.
 */

export const cameraVideoConstraints = (
	cameraId?: string | null,
): MediaTrackConstraints => ({
	...(cameraId ? { deviceId: { exact: cameraId } } : {}),
	frameRate: { ideal: 30 },
	width: { ideal: 1920 },
	height: { ideal: 1080 },
});

export const micAudioConstraints = (
	micId?: string | null,
): MediaTrackConstraints => ({
	...(micId ? { deviceId: { exact: micId } } : {}),
	echoCancellation: true,
	autoGainControl: true,
	noiseSuppression: true,
});

export const acquireCameraStream = (cameraId?: string | null) =>
	navigator.mediaDevices.getUserMedia({
		video: cameraVideoConstraints(cameraId),
	});

export const acquireMicStream = (micId?: string | null) =>
	navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(micId) });

/** Camera and mic in one call — one permission prompt instead of two. */
export const acquireCameraWithMicStream = (input: {
	cameraId?: string | null;
	micId?: string | null;
}) =>
	navigator.mediaDevices.getUserMedia({
		video: cameraVideoConstraints(input.cameraId),
		audio: micAudioConstraints(input.micId),
	});

export interface AcquireDisplayStreamOptions {
	/**
	 * Preferred surface to steer the browser picker toward; omit for the
	 * generic picker (the comment reply flow, where the picker itself is the
	 * mode selector).
	 */
	mode?: DetectedDisplayRecordingMode | null;
	systemAudioEnabled: boolean;
	/**
	 * System audio was requested but this attempt has to go on without it —
	 * fired once per fallback, before the retry, so the caller can warn.
	 */
	onSystemAudioFallback?: () => void;
}

/**
 * getDisplayMedia with the full retry ladder: preferred surface options →
 * without preferences → without system audio. User cancellation always
 * rethrows untouched so callers can treat it as a silent close.
 */
export const acquireDisplayStream = async ({
	mode,
	systemAudioEnabled,
	onSystemAudioFallback,
}: AcquireDisplayStreamOptions): Promise<MediaStream> => {
	const desiredSurface = mode ? RECORDING_MODE_TO_DISPLAY_SURFACE[mode] : null;
	const videoConstraints: MediaTrackConstraints & {
		displaySurface?: DisplaySurfacePreference;
	} = {
		...DISPLAY_MEDIA_VIDEO_CONSTRAINTS,
		// undefined dictionary members are treated as absent by the constraint
		// algorithm, so the generic-picker path adds no surface preference.
		displaySurface: desiredSurface ?? undefined,
	};

	const displayAudioConfig: boolean | MediaTrackConstraints = systemAudioEnabled
		? {
				echoCancellation: false,
				autoGainControl: false,
				noiseSuppression: false,
			}
		: false;

	const baseDisplayRequest: ExtendedDisplayMediaStreamOptions = {
		video: videoConstraints,
		audio: displayAudioConfig,
		preferCurrentTab: mode === "tab",
		...(systemAudioEnabled ? { systemAudio: "include" } : {}),
	};

	const noAudioDisplayRequest: ExtendedDisplayMediaStreamOptions = {
		video: videoConstraints,
		audio: false,
		preferCurrentTab: mode === "tab",
	};

	const preferredOptions = mode ? DISPLAY_MODE_PREFERENCES[mode] : undefined;
	let videoStream: MediaStream | null = null;

	if (preferredOptions) {
		const preferredDisplayRequest: ExtendedDisplayMediaStreamOptions = {
			...baseDisplayRequest,
			...preferredOptions,
			video: videoConstraints,
			audio: displayAudioConfig,
			...(systemAudioEnabled ? { systemAudio: "include" } : {}),
		};

		try {
			videoStream = await navigator.mediaDevices.getDisplayMedia(
				preferredDisplayRequest as DisplayMediaStreamOptions,
			);
		} catch (displayError) {
			if (isUserCancellationError(displayError)) {
				throw displayError;
			}
			if (shouldRetryDisplayMediaWithoutPreferences(displayError)) {
				console.warn(
					"Display media preferences not supported, retrying without them",
					displayError,
				);
				try {
					videoStream = await navigator.mediaDevices.getDisplayMedia(
						baseDisplayRequest as DisplayMediaStreamOptions,
					);
				} catch (audioRetryError) {
					if (
						systemAudioEnabled &&
						shouldRetryDisplayMediaWithoutPreferences(audioRetryError)
					) {
						console.warn(
							"System audio not supported, retrying without audio",
							audioRetryError,
						);
						onSystemAudioFallback?.();
						videoStream = await navigator.mediaDevices.getDisplayMedia(
							noAudioDisplayRequest as DisplayMediaStreamOptions,
						);
					} else {
						throw audioRetryError;
					}
				}
			} else if (systemAudioEnabled) {
				console.warn(
					"Display media with audio failed, retrying without system audio",
					displayError,
				);
				onSystemAudioFallback?.();
				const noAudioPreferred: ExtendedDisplayMediaStreamOptions = {
					...noAudioDisplayRequest,
					...preferredOptions,
					video: videoConstraints,
					audio: false,
				};
				try {
					videoStream = await navigator.mediaDevices.getDisplayMedia(
						noAudioPreferred as DisplayMediaStreamOptions,
					);
				} catch {
					throw displayError;
				}
			} else {
				throw displayError;
			}
		}
	}

	if (!videoStream) {
		try {
			videoStream = await navigator.mediaDevices.getDisplayMedia(
				baseDisplayRequest as DisplayMediaStreamOptions,
			);
		} catch (fallbackError) {
			if (
				systemAudioEnabled &&
				shouldRetryDisplayMediaWithoutPreferences(fallbackError)
			) {
				console.warn(
					"System audio not supported, retrying without audio",
					fallbackError,
				);
				onSystemAudioFallback?.();
				videoStream = await navigator.mediaDevices.getDisplayMedia(
					noAudioDisplayRequest as DisplayMediaStreamOptions,
				);
			} else {
				throw fallbackError;
			}
		}
	}

	return videoStream;
};

export interface AudioMixerInput {
	systemAudioTracks?: MediaStreamTrack[];
	micStream?: MediaStream | null;
}

export interface AudioMixer {
	context: AudioContext;
	/** Carries the single mixed track; its identity never changes. */
	stream: MediaStream;
	/**
	 * Swap the mic source live. Because a MediaRecorder fed from the mixer's
	 * destination track keeps recording across source graph changes, this works
	 * mid-recording with no gap.
	 */
	setMicStream: (stream: MediaStream | null) => void;
	close: () => Promise<void>;
}

/**
 * System + mic mixed through a limiter — the graph the dashboard recorder has
 * always used for system-audio recordings, generalized so any subset of
 * sources can feed it and the mic source can be replaced while live.
 */
export const createAudioMixer = async ({
	systemAudioTracks = [],
	micStream = null,
}: AudioMixerInput): Promise<AudioMixer> => {
	const context = new AudioContext();
	if (context.state !== "running") {
		await context.resume();
	}

	const destination = context.createMediaStreamDestination();
	const limiter = context.createDynamicsCompressor();
	limiter.threshold.value = -3;
	limiter.knee.value = 2;
	limiter.ratio.value = 20;
	limiter.attack.value = 0.002;
	limiter.release.value = 0.05;
	limiter.connect(destination);

	if (systemAudioTracks.length > 0) {
		context
			.createMediaStreamSource(new MediaStream(systemAudioTracks))
			.connect(limiter);
	}

	let micSource: MediaStreamAudioSourceNode | null = null;
	const setMicStream = (stream: MediaStream | null) => {
		if (micSource) {
			try {
				micSource.disconnect();
			} catch {
				/* already disconnected */
			}
			micSource = null;
		}
		if (stream && stream.getAudioTracks().length > 0) {
			micSource = context.createMediaStreamSource(stream);
			micSource.connect(limiter);
		}
	};
	setMicStream(micStream);

	return {
		context,
		stream: destination.stream,
		setMicStream,
		close: async () => {
			try {
				await context.close();
			} catch {
				/* already closed */
			}
		},
	};
};

export type CaptureSource = "camera" | "display";

export const getCaptureErrorMessage = (
	error: unknown,
	source: CaptureSource,
) => {
	if (typeof DOMException !== "undefined" && error instanceof DOMException) {
		if (error.name === "NotAllowedError" || error.name === "AbortError") {
			return source === "camera"
				? "Camera access was cancelled or blocked. Allow camera access in your browser and try again."
				: "Screen sharing was cancelled or blocked. Allow screen sharing in your browser and try again.";
		}

		if (error.name === "NotReadableError") {
			return source === "camera"
				? "Your browser couldn't start the selected camera. Close other apps or tabs using it, then try again."
				: "Your browser couldn't start screen capture. Try a different screen or window, close other screen-sharing apps, or restart the browser.";
		}

		if (error.name === "InvalidStateError") {
			return "Your browser blocked the capture request because this tab wasn't active. Bring Cap to the foreground and click Start recording again.";
		}

		if (error.name === "NotFoundError") {
			return "No recording source was available. Try another recording mode or reconnect the device.";
		}

		if (
			error.name === "OverconstrainedError" ||
			error.name === "NotSupportedError" ||
			error.name === "InvalidAccessError"
		) {
			return "Your browser rejected the capture settings. Try another recording mode, or turn off system audio and try again.";
		}

		if (error.name === "SecurityError") {
			return "Your browser blocked media capture for this site. Check site permissions or managed browser policies.";
		}
	}

	if (error instanceof TypeError) {
		if (/fetch|network|load failed|failed to fetch/i.test(error.message)) {
			return "Cap couldn't create the upload session. Check Chrome extensions, privacy settings, or network access, then try again.";
		}

		return "Your browser rejected the capture settings. Try another recording mode, or turn off system audio and try again.";
	}

	if (error instanceof Error) {
		if (error.message === "No supported recording pipeline available") {
			return "This browser can capture media but can't encode a recording. Try updating Chrome or use the desktop app.";
		}

		if (/multipart|upload|request to/i.test(error.message)) {
			return "Cap couldn't create the upload session. Check Chrome extensions, privacy settings, or network access, then try again.";
		}
	}

	return "Could not start recording. Try again, or use another browser or the desktop app if this is urgent.";
};
