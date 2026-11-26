"use client";

import { type RefObject, useEffect } from "react";

const CONTINUE_STORAGE_KEY = "cap:up-next-continue";

export function markUpNextContinue(videoId: string) {
	try {
		window.sessionStorage.setItem(CONTINUE_STORAGE_KEY, videoId);
	} catch {}
}

// Media events don't bubble, but they do pass through capturing listeners on
// window. Listening there and matching the ref on each event works for a
// player that mounts late (a video still processing) or is swapped for a new
// element, without polling for it.
export function onPlayerMediaEvent(
	videoRef: RefObject<HTMLVideoElement | null>,
	types: readonly string[],
	handler: (video: HTMLVideoElement, event: Event) => void,
) {
	const listener = (event: Event) => {
		const video = videoRef.current;
		if (video && event.target === video) handler(video, event);
	};
	for (const type of types) window.addEventListener(type, listener, true);
	return () => {
		for (const type of types) window.removeEventListener(type, listener, true);
	};
}

const canStart = (video: HTMLVideoElement) =>
	!video.ended &&
	video.paused &&
	video.currentTime < 1 &&
	video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;

// Arriving from an Up next card keeps playing: the viewer already started the
// previous video in this tab, so the browser allows playback with sound. The
// request is cleared only once handled, so a remount (or a development double
// effect) leaves it for the next mount.
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
		let stop = () => {};
		const start = (video: HTMLVideoElement) => {
			if (!canStart(video)) return;
			stop();
			try {
				window.sessionStorage.removeItem(CONTINUE_STORAGE_KEY);
			} catch {}
			void video.play().catch(() => {});
		};
		stop = onPlayerMediaEvent(videoRef, ["canplay", "loadeddata"], start);
		if (videoRef.current) start(videoRef.current);
		return () => stop();
	}, [videoRef, videoId]);
}
