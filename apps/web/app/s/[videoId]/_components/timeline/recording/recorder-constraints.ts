export const MIC_CONSTRAINTS: MediaTrackConstraints = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
};

export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
	width: { ideal: 1280 },
	height: { ideal: 720 },
	frameRate: { ideal: 30 },
};

export const DISPLAY_CONSTRAINTS: MediaStreamConstraints & {
	systemAudio?: string;
} = {
	video: { height: { ideal: 720 }, frameRate: { ideal: 30 } },
	audio: true,
	// Chromium hint; ignored elsewhere.
	systemAudio: "include",
};

const pickSupported = (candidates: string[]) => {
	if (typeof MediaRecorder === "undefined") return null;
	for (const candidate of candidates) {
		try {
			if (MediaRecorder.isTypeSupported(candidate)) return candidate;
		} catch {
			// Some engines throw on unknown container strings.
		}
	}
	return null;
};

/**
 * Prefer AAC-in-mp4 (plays everywhere including iOS) over opus-in-webm.
 * Chrome-recorded webm/opus gets a conversion pass before upload where the
 * encoder exists; the true mime always travels in mediaMeta.
 */
export const pickVoiceMime = () =>
	pickSupported([
		"audio/mp4;codecs=mp4a.40.2",
		"audio/mp4",
		"audio/webm;codecs=opus",
		"audio/webm",
	]);

/**
 * Prefer H.264 so the recording is mp4-ready without re-encoding; VP-in-webm
 * is the fallback and goes through the WebCodecs conversion pass when
 * supported (Firefox uploads raw webm — known iOS-viewer gap).
 */
export const pickVideoMime = () =>
	pickSupported([
		"video/mp4;codecs=avc1.42E01F,mp4a.40.2",
		"video/mp4",
		"video/webm;codecs=h264,opus",
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
	]);
