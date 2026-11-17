"use client";

import { type RefObject, useEffect } from "react";

const CONTINUE_STORAGE_KEY = "cap:up-next-continue";
const VIDEO_POLL_MS = 200;
const VIDEO_POLL_LIMIT = 150;
export function markUpNextContinue(videoId: string) {
	try {
		window.sessionStorage.setItem(CONTINUE_STORAGE_KEY, videoId);
	} catch {}
}

// The player mounts after the page (and not at all while a video is still
// processing), so the element is looked up on a short, bounded poll.
export function whenVideoMounted(
	videoRef: RefObject<HTMLVideoElement | null>,
	onMounted: (video: HTMLVideoElement) => () => void,
) {
	let cleanup: (() => void) | null = null;
	let tries = 0;
	const check = () => {
		const video = videoRef.current;
		if (video) {
			window.clearInterval(timer);
			cleanup = onMounted(video);
		} else if (++tries >= VIDEO_POLL_LIMIT) window.clearInterval(timer);
	};
	const timer = window.setInterval(check, VIDEO_POLL_MS);
	check();
	return () => {
		window.clearInterval(timer);
		cleanup?.();
	};
}

// Arriving from an Up next card keeps playing: the viewer already started the
// previous video in this tab, so the browser allows playback with sound. The
// ref is re-read on every tick because a soft navigation can keep the previous
// (ended) element mounted until the new player replaces it.
export function useContinueFromUpNext(
	videoRef: RefObject<HTMLVideoElement | null>,
	videoId: string,
) {
	useEffect(() => {
		let pending = false;
		try {
			pending = window.sessionStorage.getItem(CONTINUE_STORAGE_KEY) === videoId;
		} catch {}
		if (!pending) return;
		// Cleared only once handled, so a remount (or a development double
		// effect) that cancels this poll leaves the request for the next one.
		const clear = () => {
			try {
				window.sessionStorage.removeItem(CONTINUE_STORAGE_KEY);
			} catch {}
		};
		let tries = 0;
		const timer = window.setInterval(() => {
			const video = videoRef.current;
			tries++;
			if (
				video &&
				!video.ended &&
				video.paused &&
				video.currentTime < 1 &&
				video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
			) {
				window.clearInterval(timer);
				clear();
				void video.play().catch(() => {});
			} else if (tries >= VIDEO_POLL_LIMIT) {
				window.clearInterval(timer);
				clear();
			}
		}, VIDEO_POLL_MS);
		return () => window.clearInterval(timer);
	}, [videoRef, videoId]);
}
