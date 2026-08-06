"use client";

import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPlaybackStore, type PlaybackStore } from "./playback-store";
import { useVideoElement } from "./useVideoElement";

const PlaybackContext = createContext<PlaybackStore | null>(null);

interface PlaybackProviderProps {
	videoRef: RefObject<HTMLVideoElement | null>;
	stageRef: RefObject<HTMLElement | null>;
	fallbackDuration?: number | null;
	children: ReactNode;
}

export function PlaybackProvider({
	videoRef,
	stageRef,
	fallbackDuration = 0,
	children,
}: PlaybackProviderProps) {
	// One store per provider mount. The context value is the store itself, so its
	// identity never changes and consumers never re-render because of us.
	const storeRef = useRef<PlaybackStore | null>(null);
	if (storeRef.current === null) {
		storeRef.current = createPlaybackStore(fallbackDuration);
	}
	const store = storeRef.current;

	useEffect(() => {
		store.setFallbackDuration(fallbackDuration ?? 0);
	}, [store, fallbackDuration]);

	useVideoElement({ store, videoRef, stageRef });

	return (
		<PlaybackContext.Provider value={store}>
			{children}
		</PlaybackContext.Provider>
	);
}

/**
 * Subscription handle for the share page's media element. Stable for the life
 * of the provider, so it is safe to put in dependency arrays.
 */
export function usePlayback(): PlaybackStore {
	const store = useContext(PlaybackContext);
	if (!store) {
		throw new Error("usePlayback must be used inside a <PlaybackProvider>");
	}
	return store;
}

/**
 * Like `usePlayback`, but null outside a provider — for components that also
 * render in trees with no main video (composer previews, embeds).
 */
export function useOptionalPlayback(): PlaybackStore | null {
	return useContext(PlaybackContext);
}

const getServerPlaying = () => false;

/** Re-renders only when playback starts or stops. */
export function usePlaying(): boolean {
	const store = usePlayback();
	return useSyncExternalStore(
		store.subscribePlaying,
		store.getPlaying,
		getServerPlaying,
	);
}

const now = () =>
	typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Current time as React state, throttled to at most one update per
 * `intervalMs`. For consumers that need a number in the render tree (labels,
 * active-chapter highlighting) rather than a DOM write.
 */
export function useCoarseTime(intervalMs = 250): number {
	const store = usePlayback();
	const [time, setTime] = useState(() => store.getCurrentTime());

	useEffect(() => {
		let last = Number.NEGATIVE_INFINITY;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pending: number | null = null;

		const flush = () => {
			timer = null;
			if (pending === null) return;
			last = now();
			const value = pending;
			pending = null;
			setTime(value);
		};

		const unsubscribe = store.subscribe((next) => {
			const elapsed = now() - last;
			if (elapsed >= intervalMs) {
				if (timer !== null) {
					clearTimeout(timer);
					timer = null;
				}
				pending = null;
				last = now();
				setTime(next);
				return;
			}
			// Hold the newest value and flush it on the trailing edge, so a pause
			// mid-interval still lands on the real final position.
			pending = next;
			if (timer === null) timer = setTimeout(flush, intervalMs - elapsed);
		});

		return () => {
			unsubscribe();
			if (timer !== null) clearTimeout(timer);
		};
	}, [store, intervalMs]);

	return time;
}
