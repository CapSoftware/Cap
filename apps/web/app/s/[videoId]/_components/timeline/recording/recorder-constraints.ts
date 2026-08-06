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
 * encoder exists; the true mime always travels in mediaMeta. Video comments
 * pick their mime through the engine's pipeline selector instead — audio-only
 * recording is the one capture the web recorder engine doesn't cover.
 */
export const pickVoiceMime = () =>
	pickSupported([
		"audio/mp4;codecs=mp4a.40.2",
		"audio/mp4",
		"audio/webm;codecs=opus",
		"audio/webm",
	]);
