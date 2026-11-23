import {
	PLAYBACK_URL_EXPIRES_SECONDS,
	STREAM_URL_MIN_SECONDS,
} from "@/lib/signed-url-validity";

const MAX_SOURCE_REFRESHES = 5;
const MIN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MIN_TRUSTED_LIFETIME_MS = 10 * 60 * 1000;
const DUE_CHECK_INTERVAL_MS = 60 * 1000;
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

function fromCloudFrontBase64(value: string) {
	return atob(value.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"));
}

function amzDateMs(value: string) {
	const iso = value.replace(
		/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
		"$1-$2-$3T$4:$5:$6Z",
	);
	if (iso === value) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

export function signedUrlExpiresAt(url: string): number | null {
	try {
		const query = new URL(url, "https://cap.so").searchParams;
		const expires = query.get("Expires");
		if (expires) {
			const seconds = Number(expires);
			return Number.isFinite(seconds) ? seconds * 1000 : null;
		}
		const policy = query.get("Policy");
		if (policy) {
			const seconds = JSON.parse(fromCloudFrontBase64(policy))?.Statement?.[0]
				?.Condition?.DateLessThan?.["AWS:EpochTime"];
			return typeof seconds === "number" ? seconds * 1000 : null;
		}
		const signedAt = amzDateMs(query.get("X-Amz-Date") ?? "");
		const lifetime = Number(query.get("X-Amz-Expires"));
		if (signedAt !== null && Number.isFinite(lifetime) && lifetime > 0)
			return signedAt + lifetime * 1000;
	} catch {
		return null;
	}
	return null;
}

// A source is replaced a tenth of its lifetime before it expires, which also
// absorbs a viewer's clock running behind the CDN's. A lifetime under ten
// minutes at load means the viewer's clock can't be trusted for this.
export function refreshDueAt(lifetimeMs: number, now: number = Date.now()) {
	if (!(lifetimeMs >= MIN_TRUSTED_LIFETIME_MS)) return null;
	return now + lifetimeMs - Math.max(MIN_REFRESH_MARGIN_MS, lifetimeMs / 10);
}

export function signedUrlRefreshDueAt(url: string, now: number = Date.now()) {
	const expiresAt = signedUrlExpiresAt(url);
	return expiresAt === null ? null : refreshDueAt(expiresAt - now, now);
}

export const streamRefreshDueAt = (now: number = Date.now()) =>
	refreshDueAt(STREAM_URL_MIN_SECONDS * 1000, now);

export const playbackRefreshDueAt = (now: number = Date.now()) =>
	refreshDueAt(PLAYBACK_URL_EXPIRES_SECONDS * 1000, now);

// Safari's media loader treats a refused range as media data and asks for the
// next range hundreds of times a second without reporting an error, so a
// signed source has to be replaced before it expires. Timers pause while a
// computer sleeps, so the wall clock is checked whenever playback may need
// data, when the page becomes visible, and once a minute. A finished video
// waits until it is played or seeked again.
export function whenSourceRefreshDue(
	media: HTMLMediaElement,
	dueAt: number,
	onDue: () => boolean | Promise<boolean>,
	{ poll = true }: { poll?: boolean } = {},
): () => void {
	let done = false;
	let pending = false;
	const check = () => {
		if (done || pending || media.ended || Date.now() < dueAt) return;
		pending = true;
		void Promise.resolve()
			.then(onDue)
			.then(
				(refreshed) => {
					if (refreshed) done = true;
				},
				() => undefined,
			)
			.finally(() => {
				pending = false;
			});
	};
	const interval = poll ? setInterval(check, DUE_CHECK_INTERVAL_MS) : null;
	if (poll) document.addEventListener("visibilitychange", check);
	media.addEventListener("play", check);
	media.addEventListener("seeking", check);
	media.addEventListener("waiting", check);
	return () => {
		done = true;
		if (interval) clearInterval(interval);
		media.removeEventListener("play", check);
		media.removeEventListener("seeking", check);
		media.removeEventListener("waiting", check);
		document.removeEventListener("visibilitychange", check);
	};
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

// Loading a new source puts the element back to 0:00 until it seeks to where
// the viewer was, so controls read the viewer's time from here until then.
// Restore logic and hls.js keep reading the element's own position.
const heldTimes = new WeakMap<object, { time: number }>();

export function displayedMediaTime(media: { currentTime?: number }): number {
	return heldTimes.get(media)?.time ?? media.currentTime ?? 0;
}

export function isMediaTimeHeld(media: HTMLMediaElement) {
	return heldTimes.has(media);
}

// The element shows nothing between losing its source and painting the new
// one, so a still of the last frame covers it until then.
const frameCovers = new WeakMap<
	HTMLVideoElement,
	{ canvas: HTMLCanvasElement; owner: object }
>();
const FRAME_COVER_MAX_MS = 500;

function coverVideoFrame(video: HTMLVideoElement, owner: object) {
	const existing = frameCovers.get(video);
	if (existing) {
		existing.owner = owner;
		return;
	}
	if (video.readyState < 2 || !video.videoWidth || !video.isConnected) return;
	const canvas = document.createElement("canvas");
	const scale = Math.min(
		1,
		(video.offsetWidth * (window.devicePixelRatio || 1)) / video.videoWidth,
	);
	canvas.width = Math.max(1, Math.round(video.videoWidth * (scale || 1)));
	canvas.height = Math.max(1, Math.round(video.videoHeight * (scale || 1)));
	const context = canvas.getContext("2d");
	if (!context) return;
	try {
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
	} catch {
		return;
	}
	const style = getComputedStyle(video);
	Object.assign(canvas.style, {
		position: "absolute",
		left: `${video.offsetLeft}px`,
		top: `${video.offsetTop}px`,
		width: `${video.offsetWidth}px`,
		height: `${video.offsetHeight}px`,
		objectFit: style.objectFit,
		objectPosition: style.objectPosition,
		borderRadius: style.borderRadius,
		zIndex: style.zIndex,
		pointerEvents: "none",
	});
	canvas.setAttribute("aria-hidden", "true");
	video.after(canvas);
	frameCovers.set(video, { canvas, owner });
}

function uncoverVideoFrame(video: HTMLVideoElement, owner: object) {
	const cover = frameCovers.get(video);
	if (!cover || cover.owner !== owner) return;
	const remove = () => {
		if (frameCovers.get(video) !== cover || cover.owner !== owner) return;
		frameCovers.delete(video);
		cover.canvas.remove();
	};
	setTimeout(remove, FRAME_COVER_MAX_MS);
	if (typeof video.requestVideoFrameCallback === "function")
		video.requestVideoFrameCallback(remove);
	else requestAnimationFrame(() => requestAnimationFrame(remove));
}

export function holdDisplayedTime(
	media: HTMLMediaElement,
	time: number,
): () => void {
	const hold = { time };
	heldTimes.set(media, hold);
	if (media instanceof HTMLVideoElement) coverVideoFrame(media, hold);
	let loadStarted = false;
	const handleLoadStart = () => {
		loadStarted = true;
	};
	const handleSettled = () => {
		if (loadStarted && !media.seeking) release();
	};
	const handleTimeUpdate = () => {
		if (
			loadStarted &&
			!media.seeking &&
			media.readyState >= 1 &&
			Math.abs(media.currentTime - hold.time) < 0.5
		)
			release();
	};
	const release = () => {
		media.removeEventListener("loadstart", handleLoadStart);
		media.removeEventListener("seeked", handleSettled);
		media.removeEventListener("error", handleSettled);
		media.removeEventListener("timeupdate", handleTimeUpdate);
		if (media instanceof HTMLVideoElement) uncoverVideoFrame(media, hold);
		if (heldTimes.get(media) !== hold) return;
		heldTimes.delete(media);
		media.dispatchEvent(new Event("timeupdate"));
	};
	media.addEventListener("loadstart", handleLoadStart);
	media.addEventListener("seeked", handleSettled);
	media.addEventListener("error", handleSettled);
	media.addEventListener("timeupdate", handleTimeUpdate);
	return release;
}

export function capturePlayback(
	media: HTMLMediaElement,
	wasPlaying = !media.paused && !media.ended,
): PlaybackSnapshot {
	const time = displayedMediaTime(media);
	return {
		time: Number.isFinite(time) ? time : 0,
		wasPlaying,
		playbackRate: media.playbackRate,
	};
}

// Chrome marks the element paused before it reports a failed load, and the
// matching pause event follows the error, so whether the viewer was watching
// comes from the play and pause events rather than the paused flag.
export function trackPlaybackIntent(media: HTMLMediaElement) {
	let playing = !media.paused && !media.ended;
	const handlePlay = () => {
		playing = true;
	};
	const handlePause = () => {
		if (!media.error) playing = false;
	};
	const handleEnded = () => {
		playing = false;
	};
	media.addEventListener("play", handlePlay);
	media.addEventListener("pause", handlePause);
	media.addEventListener("ended", handleEnded);
	return {
		isPlaying: () => playing || (!media.paused && !media.ended),
		stop: () => {
			media.removeEventListener("play", handlePlay);
			media.removeEventListener("pause", handlePause);
			media.removeEventListener("ended", handleEnded);
		},
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
// has metadata. A paused viewer stays paused even when the element has
// autoplay, and a pause once the new source starts loading (the viewer, or
// another player taking over) cancels the resume; the browser's own pause for
// a failed load arrives before that.
export function restorePlaybackOnLoad(
	media: HTMLMediaElement,
	snapshot: PlaybackSnapshot,
): () => void {
	let finished = false;
	let resume = snapshot.wasPlaying;
	let loadStarted = false;
	if (!resume) media.autoplay = false;
	const releaseTime = holdDisplayedTime(media, snapshot.time);
	const finish = () => {
		if (finished) return;
		finished = true;
		cleanup();
		media.playbackRate = snapshot.playbackRate;
		if (resume) void media.play().catch(() => undefined);
		releaseTime();
	};
	const handleLoadStart = () => {
		loadStarted = true;
	};
	const handlePause = () => {
		if (loadStarted) resume = false;
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
		media.removeEventListener("loadstart", handleLoadStart);
		media.removeEventListener("pause", handlePause);
		media.removeEventListener("loadedmetadata", handleLoadedMetadata);
		media.removeEventListener("seeked", finish);
	};
	media.addEventListener("loadstart", handleLoadStart);
	media.addEventListener("pause", handlePause);
	media.addEventListener("loadedmetadata", handleLoadedMetadata);
	media.addEventListener("seeked", finish);
	return () => {
		finished = true;
		cleanup();
		releaseTime();
	};
}

// For an element whose src is a Cap route that redirects to a signed URL:
// loading the same src again asks the route for a fresh signature. Comment
// clips are short and buffered whole, so only playback activity is checked,
// which leaves nothing running once the element is gone.
const watchedMedia = new WeakMap<HTMLMediaElement, () => void>();

export function watchExpiredMediaSource(media: HTMLMediaElement): () => void {
	const existing = watchedMedia.get(media);
	if (existing) return existing;
	const refreshes = createSourceRefreshBudget();
	const intent = trackPlaybackIntent(media);
	let obtainedAt = Date.now();
	let cancelRestore: (() => void) | null = null;
	let stopDueCheck: (() => void) | null = null;
	const reload = () => {
		const previousRestore = cancelRestore;
		cancelRestore = restorePlaybackOnLoad(
			media,
			capturePlayback(media, intent.isPlaying()),
		);
		previousRestore?.();
		obtainedAt = Date.now();
		media.load();
		armDueCheck();
	};
	const armDueCheck = () => {
		stopDueCheck?.();
		const dueAt = playbackRefreshDueAt(obtainedAt);
		stopDueCheck =
			dueAt === null
				? null
				: whenSourceRefreshDue(
						media,
						dueAt,
						() => {
							reload();
							return true;
						},
						{ poll: false },
					);
	};
	const handleLoaded = () => refreshes.markLoaded();
	const handleError = () => {
		if (
			!media.currentSrc ||
			!isMediaLoadError(media.error) ||
			!sourceMayHaveExpired(obtainedAt) ||
			!refreshes.tryStart()
		)
			return;
		reload();
	};
	armDueCheck();
	media.addEventListener("loadeddata", handleLoaded);
	media.addEventListener("error", handleError);
	const stop = () => {
		cancelRestore?.();
		stopDueCheck?.();
		intent.stop();
		media.removeEventListener("loadeddata", handleLoaded);
		media.removeEventListener("error", handleError);
		watchedMedia.delete(media);
	};
	watchedMedia.set(media, stop);
	return stop;
}
