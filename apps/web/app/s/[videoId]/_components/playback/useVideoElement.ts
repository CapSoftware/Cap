"use client";

import { type RefObject, useEffect } from "react";
import type { PlaybackStore } from "./playback-store";

interface UseVideoElementOptions {
	store: PlaybackStore;
	/** Imperative handle forwarded by `ShareVideo`. */
	videoRef: RefObject<HTMLVideoElement | null>;
	/** The stage card, used both as the query root and the mutation scope. */
	stageRef: RefObject<HTMLElement | null>;
}

/**
 * Keeps `store` attached to whichever `<video>` is currently live inside the
 * stage.
 *
 * `ShareVideo`'s `useImperativeHandle(ref, () => videoRef.current, [])` has
 * empty deps, so the forwarded ref is captured once and goes stale the moment
 * the player swaps between its HLS and MP4 implementations. We therefore treat
 * the forwarded ref as a hint only: it wins when it still points at a mounted
 * element, otherwise we fall back to querying the stage. A MutationObserver on
 * the stage catches the swap itself, and `loadedmetadata` (captured, since it
 * does not bubble) catches the case where the element is reused but reloaded.
 */
export function useVideoElement({
	store,
	videoRef,
	stageRef,
}: UseVideoElementOptions) {
	useEffect(() => {
		const stage = stageRef.current;

		const resolve = (): HTMLVideoElement | null => {
			const fromRef = videoRef.current;
			if (fromRef?.isConnected) return fromRef;
			return stage?.querySelector("video") ?? null;
		};

		let attached: HTMLVideoElement | null = null;
		const sync = () => {
			const next = resolve();
			if (next === attached) return;
			attached = next;
			store.attach(next);
		};

		sync();

		let observer: MutationObserver | null = null;
		if (stage && typeof MutationObserver === "function") {
			observer = new MutationObserver(sync);
			observer.observe(stage, { childList: true, subtree: true });
		}
		stage?.addEventListener("loadedmetadata", sync, true);

		return () => {
			observer?.disconnect();
			stage?.removeEventListener("loadedmetadata", sync, true);
			store.detach();
		};
	}, [store, videoRef, stageRef]);
}
