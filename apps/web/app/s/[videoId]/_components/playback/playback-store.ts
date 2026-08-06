/**
 * Framework-free subscription store around the share page's `<video>` element.
 *
 * The share page grew a second view (timeline) whose consumers need the current
 * playback time at frame rate. Putting that in React state would re-render the
 * whole page 60 times a second, so instead everything subscribes here and
 * writes to the DOM directly.
 *
 * A single `requestAnimationFrame` loop runs *only* while the media is playing
 * (mirroring the follow loop in `edit/EditVideoClient.tsx`). While paused the
 * store still emits one-shot updates from `seeking`/`seeked`/`timeupdate`/
 * `loadedmetadata`, so scrubbing stays live without burning frames.
 */

export type TimeSubscriber = (time: number) => void;
export type PlayingSubscriber = () => void;

export type PlaybackStore = ReturnType<typeof createPlaybackStore>;

const isFiniteDuration = (value: number | null | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

const normalizeDuration = (value: number | null | undefined): number =>
	isFiniteDuration(value) ? value : 0;

export function createPlaybackStore(fallbackDuration: number | null = 0) {
	let element: HTMLVideoElement | null = null;
	let frame = 0;
	let time = 0;
	let playing = false;
	let fallback = normalizeDuration(fallbackDuration);
	let duration = fallback;

	const timeSubscribers = new Set<TimeSubscriber>();
	const playingSubscribers = new Set<PlayingSubscriber>();

	const emitTime = () => {
		for (const subscriber of timeSubscribers) subscriber(time);
	};

	const setPlaying = (next: boolean) => {
		if (playing === next) return;
		playing = next;
		for (const subscriber of playingSubscribers) subscriber();
	};

	/** Pull `currentTime`/`duration` off the element and notify time subscribers. */
	const sample = (force = false) => {
		if (element && isFiniteDuration(element.duration)) {
			duration = element.duration;
		}
		const next = element?.currentTime ?? time;
		if (next === time && !force) return;
		time = next;
		emitTime();
	};

	const stopFrames = () => {
		if (frame === 0) return;
		cancelAnimationFrame(frame);
		frame = 0;
	};

	const tick = () => {
		frame = 0;
		sample();
		if (element && !element.paused && !element.ended) {
			frame = requestAnimationFrame(tick);
		}
	};

	const startFrames = () => {
		if (frame !== 0) return;
		if (typeof requestAnimationFrame !== "function") return;
		frame = requestAnimationFrame(tick);
	};

	const handlePlay = () => {
		setPlaying(true);
		startFrames();
	};

	const handleStop = () => {
		stopFrames();
		setPlaying(false);
		sample(true);
	};

	const handleTimeChange = () => sample();

	const MEDIA_EVENTS = [
		["play", handlePlay],
		["playing", handlePlay],
		["pause", handleStop],
		["ended", handleStop],
		["seeking", handleTimeChange],
		["seeked", handleTimeChange],
		["timeupdate", handleTimeChange],
		["loadedmetadata", handleTimeChange],
		["durationchange", handleTimeChange],
	] as const;

	const teardown = () => {
		stopFrames();
		if (!element) return;
		for (const [event, handler] of MEDIA_EVENTS) {
			element.removeEventListener(event, handler);
		}
		element = null;
	};

	/**
	 * Point the store at a (possibly new) media element. Safe to call with the
	 * element that is already attached, which is a no-op.
	 */
	const attach = (next: HTMLVideoElement | null) => {
		if (next === element) return;
		teardown();
		if (!next) {
			setPlaying(false);
			sample(true);
			return;
		}
		element = next;
		for (const [event, handler] of MEDIA_EVENTS) {
			element.addEventListener(event, handler);
		}
		sample(true);
		if (!element.paused && !element.ended) handlePlay();
		else setPlaying(false);
	};

	const detach = () => {
		teardown();
		setPlaying(false);
	};

	const subscribe = (subscriber: TimeSubscriber) => {
		timeSubscribers.add(subscriber);
		// Hand the subscriber the current position straight away so it can paint
		// once on mount instead of waiting for the next media event.
		subscriber(time);
		return () => {
			timeSubscribers.delete(subscriber);
		};
	};

	const subscribePlaying = (subscriber: PlayingSubscriber) => {
		playingSubscribers.add(subscriber);
		return () => {
			playingSubscribers.delete(subscriber);
		};
	};

	const getCurrentTime = () => element?.currentTime ?? time;

	const getDuration = () => {
		if (element && isFiniteDuration(element.duration)) return element.duration;
		return duration || fallback;
	};

	const getPlaying = () => playing;

	const setFallbackDuration = (next: number | null) => {
		fallback = normalizeDuration(next);
		if (!isFiniteDuration(duration)) duration = fallback;
	};

	const seek = (target: number) => {
		if (!element) return;
		const total = getDuration();
		const clamped = isFiniteDuration(total)
			? Math.max(0, Math.min(total - 0.001, target))
			: Math.max(0, target);
		try {
			element.currentTime = clamped;
		} catch (error) {
			console.error("Failed to seek video:", error);
			return;
		}
		sample(true);
	};

	const play = () => {
		const started = element?.play();
		if (started && typeof started.catch === "function") {
			started.catch(() => {
				/* autoplay rejections are the caller's problem, not ours */
			});
		}
	};

	const pause = () => element?.pause();

	const getElement = () => element;

	return {
		attach,
		detach,
		subscribe,
		subscribePlaying,
		getCurrentTime,
		getDuration,
		getPlaying,
		getElement,
		setFallbackDuration,
		seek,
		play,
		pause,
	};
}
