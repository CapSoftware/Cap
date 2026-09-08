"use client";

/**
 * Module-level traffic control for every media element on the share page.
 *
 * Three rules, all of them global, none of them expressible inside a single
 * card:
 *
 *  1. Only one comment media plays at a time — a new claim stops the old one.
 *  2. A comment taking over pauses the main video, and hands playback back
 *     when it is done *only* if the main video was actually playing.
 *  3. The main video starting wins outright and stops all comment media.
 *
 * The state is a module singleton rather than context because the cards live in
 * several trees (sidebar list, timeline lane, composer preview) and must still
 * see each other. React only enters through `useMainVideoInterlock`, which
 * registers the share page's playback store and refcounts its subscription so
 * dozens of mounted cards still add up to exactly one listener.
 */

import { useEffect } from "react";
import { useOptionalPlayback } from "../playback/PlaybackContext";
import type { PlaybackStore } from "../playback/playback-store";

type Active = { el: HTMLMediaElement; stop: () => void };

let active: Active | null = null;

/** The playback store of the main video, while at least one card is mounted. */
let mainStore: PlaybackStore | null = null;
/** The main video was playing when a comment took over, so it is owed a resume. */
let resumeMain = false;

/**
 * Register `el` as the one playing comment media, stopping whoever held the
 * slot before. `stop` must leave the element paused; for the video card it also
 * collapses the card back to its poster.
 */
export function claimPlayback(el: HTMLMediaElement, stop: () => void): void {
	const previous = active && active.el !== el ? active : null;
	// Install the new claim *before* stopping the old one: the outgoing card
	// pauses synchronously, and its own `pause` handler must see that it no
	// longer owns the slot so it does not hand the main video back mid-swap.
	active = { el, stop };
	previous?.stop();
}

/**
 * Give up the slot. `resumeMain` marks the end of a whole interaction (playback
 * ended, the card collapsed, the card unmounted) as opposed to a plain pause,
 * and is the only way the main video is handed back.
 */
export function releasePlayback(
	el: HTMLMediaElement,
	options?: { resumeMain?: boolean },
): void {
	// Someone else already took the slot; they own the main video now.
	if (active?.el !== el) return;
	active = null;
	if (!resumeMain) return;
	resumeMain = false;
	if (!options?.resumeMain) return;
	// Guard against the store already running: `play()` on a playing element is
	// a no-op, but skipping it keeps us out of its subscriber notifications.
	if (mainStore && !mainStore.getPlaying()) mainStore.play();
}

/**
 * Stop whatever comment media is playing. Called when the main video starts, so
 * the pending resume is dropped rather than honoured — the main video is
 * already back.
 */
export function stopAll(): void {
	const current = active;
	active = null;
	resumeMain = false;
	current?.stop();
}

/**
 * Called by a card as it starts playing. Captures whether the main video was
 * running and pauses it. A second card taking over does not re-capture: the
 * main video is already paused, and the original answer is still the right one.
 */
export function suspendMainVideo(): void {
	if (!mainStore || resumeMain) return;
	resumeMain = mainStore.getPlaying();
	if (resumeMain) mainStore.pause();
}

const interlocks = new Map<
	PlaybackStore,
	{ refs: number; unsubscribe: () => void }
>();

/**
 * Wires the main video into the registry for as long as any media comment is
 * mounted. Safe (and intended) to call from every `MediaCommentBody`: the
 * subscription itself is refcounted per store, so N cards cost one listener.
 */
export function useMainVideoInterlock(): void {
	const playback = useOptionalPlayback();

	useEffect(() => {
		if (!playback) return;

		mainStore = playback;
		const existing = interlocks.get(playback);
		if (existing) {
			existing.refs += 1;
		} else {
			interlocks.set(playback, {
				refs: 1,
				unsubscribe: playback.subscribePlaying(() => {
					if (playback.getPlaying()) stopAll();
				}),
			});
		}

		return () => {
			const entry = interlocks.get(playback);
			if (!entry) return;
			entry.refs -= 1;
			if (entry.refs > 0) return;
			entry.unsubscribe();
			interlocks.delete(playback);
			if (mainStore !== playback) return;
			mainStore = null;
			resumeMain = false;
		};
	}, [playback]);
}
