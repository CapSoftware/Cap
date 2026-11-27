const DURATION_TIMEOUT_MS = 30_000;

/**
 * Resolves the duration of a media element whose metadata has loaded.
 *
 * WebM recorded with `MediaRecorder.start(timeslice)`, which the speed and
 * trim tools write, has no duration in its header, so the element reports
 * Infinity until playback reaches the end. Seeking past the end makes the
 * browser find the real duration, then this seeks back to the start.
 */
export function resolveMediaDuration(
	media: HTMLMediaElement,
	timeoutMs = DURATION_TIMEOUT_MS,
): Promise<number> {
	if (Number.isFinite(media.duration)) return Promise.resolve(media.duration);

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			media.removeEventListener("durationchange", onDurationChange);
			media.removeEventListener("seeked", onSeeked);
			media.removeEventListener("error", onFailure);
			media.removeEventListener("emptied", onFailure);
		};
		const onFailure = () => {
			cleanup();
			reject(new Error("Could not read the video's duration"));
		};
		const onSeeked = () => {
			if (media.currentTime !== 0) return;
			cleanup();
			resolve(media.duration);
		};
		const onDurationChange = () => {
			if (!Number.isFinite(media.duration)) return;
			media.removeEventListener("durationchange", onDurationChange);
			media.addEventListener("seeked", onSeeked);
			media.currentTime = 0;
		};

		const timeout = setTimeout(onFailure, timeoutMs);
		media.addEventListener("durationchange", onDurationChange);
		media.addEventListener("error", onFailure);
		media.addEventListener("emptied", onFailure);
		media.currentTime = Number.MAX_SAFE_INTEGER;
	});
}
