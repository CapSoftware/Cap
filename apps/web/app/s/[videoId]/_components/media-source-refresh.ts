const MAX_SOURCE_REFRESHES = 5;
// Every playback URL Cap signs lasts at least 12 hours, so a source that fails
// within minutes of loading has not expired and keeps the player's normal
// error handling.
const MIN_EXPIRED_SOURCE_AGE_MS = 5 * 60 * 1000;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export type PlaybackSnapshot = {
	time: number;
	wasPlaying: boolean;
	playbackRate: number;
};

export function isSignedMediaUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	try {
		const { searchParams } = new URL(url, "https://cap.so");
		return (
			(searchParams.has("Signature") && searchParams.has("Key-Pair-Id")) ||
			searchParams.has("X-Amz-Signature")
		);
	} catch {
		return false;
	}
}

// A CDN that refuses an expired URL fails the load, which media elements
// report as a network error mid-playback or as an unsupported source when the
// first request is refused. Decode errors are never an expired URL.
export function isMediaLoadError(error: MediaError | null | undefined) {
	return (
		error?.code === MEDIA_ERR_NETWORK ||
		error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED
	);
}

export function sourceMayHaveExpired(
	obtainedAt: number,
	now: number = Date.now(),
) {
	return now - obtainedAt >= MIN_EXPIRED_SOURCE_AGE_MS;
}

export function capturePlayback(media: HTMLMediaElement): PlaybackSnapshot {
	return {
		time: Number.isFinite(media.currentTime) ? media.currentTime : 0,
		wasPlaying: !media.paused && !media.ended,
		playbackRate: media.playbackRate,
	};
}

// A new source is only fetched again once the previous one played, so a
// source that keeps failing falls through to the player's error handling
// instead of looping.
export function createSourceRefreshBudget(maxRefreshes = MAX_SOURCE_REFRESHES) {
	let refreshes = 0;
	let loadedSinceRefresh = true;
	return {
		tryStart() {
			if (!loadedSinceRefresh || refreshes >= maxRefreshes) return false;
			refreshes += 1;
			loadedSinceRefresh = false;
			return true;
		},
		markLoaded() {
			loadedSinceRefresh = true;
		},
	};
}

export type SourceRefreshBudget = ReturnType<typeof createSourceRefreshBudget>;

// Loading a new source resets the element to the start, paused, at the
// default rate. This puts it back where the viewer was once the new source
// has metadata.
export function restorePlaybackOnLoad(
	media: HTMLMediaElement,
	snapshot: PlaybackSnapshot,
): () => void {
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		cleanup();
		media.playbackRate = snapshot.playbackRate;
		if (snapshot.wasPlaying) void media.play().catch(() => undefined);
	};
	const handleLoadedMetadata = () => {
		const duration = media.duration;
		const time = Number.isFinite(duration)
			? Math.min(snapshot.time, Math.max(0, duration - 0.1))
			: snapshot.time;
		if (time <= 0) {
			finish();
			return;
		}
		try {
			media.currentTime = time;
		} catch {
			finish();
		}
	};
	const cleanup = () => {
		media.removeEventListener("loadedmetadata", handleLoadedMetadata);
		media.removeEventListener("seeked", finish);
	};
	media.addEventListener("loadedmetadata", handleLoadedMetadata);
	media.addEventListener("seeked", finish);
	return () => {
		finished = true;
		cleanup();
	};
}

// For an element whose src is a Cap route that redirects to a signed URL:
// loading the same src again asks the route for a fresh signature.
const watchedMedia = new WeakMap<HTMLMediaElement, () => void>();

export function watchExpiredMediaSource(media: HTMLMediaElement): () => void {
	const existing = watchedMedia.get(media);
	if (existing) return existing;
	const refreshes = createSourceRefreshBudget();
	let obtainedAt = Date.now();
	let cancelRestore: (() => void) | null = null;
	const handleLoaded = () => refreshes.markLoaded();
	const handleError = () => {
		if (
			!isMediaLoadError(media.error) ||
			!sourceMayHaveExpired(obtainedAt) ||
			!refreshes.tryStart()
		)
			return;
		cancelRestore?.();
		cancelRestore = restorePlaybackOnLoad(media, capturePlayback(media));
		obtainedAt = Date.now();
		media.load();
	};
	media.addEventListener("loadeddata", handleLoaded);
	media.addEventListener("error", handleError);
	const stop = () => {
		cancelRestore?.();
		media.removeEventListener("loadeddata", handleLoaded);
		media.removeEventListener("error", handleError);
		watchedMedia.delete(media);
	};
	watchedMedia.set(media, stop);
	return stop;
}
