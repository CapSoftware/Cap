"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { setFullLength } from "./early-length";

// The playlist only holds what has uploaded, so a seek past it is held until
// that part arrives instead of letting the browser clamp it to the end.

const STATUS_POLL_MS = 2_000;
const STALLED_AFTER_MS = 30_000;

export type EarlyPlaybackStatus = {
	ready: number | null;
	recorded: number | null;
	uploadComplete: boolean;
};

export type EarlyPlaybackState = {
	ready: number;
	recorded: number | null;
	uploadComplete: boolean;
	held: number | null;
	atEdge: boolean;
	stalled: boolean;
};

function readSeconds(value: string | null): number | null {
	if (value === null || value.trim() === "") return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function parseEarlyPlaybackStatus(response: {
	status: number;
	headers: Pick<Headers, "get">;
}): EarlyPlaybackStatus | null {
	if (response.status !== 204) return null;
	return {
		ready: readSeconds(response.headers.get("X-Cap-Ready-Duration")),
		recorded: readSeconds(response.headers.get("X-Cap-Recorded-Duration")),
		uploadComplete: response.headers.get("X-Cap-Recording-Complete") === "1",
	};
}

export function getMediaEnd(
	video: Pick<HTMLMediaElement, "duration" | "seekable">,
): number {
	const duration = Number.isFinite(video.duration) ? video.duration : 0;
	const seekable =
		video.seekable.length > 0
			? video.seekable.end(video.seekable.length - 1)
			: 0;
	return Math.max(duration, seekable, 0);
}

// hls.js places its start position before the duration is known, so seeks
// pass untouched until then.
export function canSeekNow(
	target: number,
	mediaEnd: number,
	playerComplete: boolean,
): boolean {
	return playerComplete || mediaEnd <= 0 || target <= mediaEnd - 0.05;
}

export function canResolveHold(
	target: number,
	{
		ready,
		recorded,
		mediaEnd,
		uploadComplete,
		playerComplete,
	}: {
		ready: number;
		recorded: number | null;
		mediaEnd: number;
		uploadComplete: boolean;
		playerComplete: boolean;
	},
): boolean {
	// The playlist can end before the element reports its final duration, so
	// a target past the old end waits for that duration instead of landing on
	// the old end.
	if (playerComplete)
		return (
			mediaEnd > 0 &&
			(mediaEnd >= target - 0.05 ||
				(recorded !== null && mediaEnd >= recorded - 0.25))
		);
	if (uploadComplete) return mediaEnd >= Math.min(target + 0.25, ready - 0.05);
	return ready >= target + 1 && mediaEnd >= target + 0.25;
}

export function isAtUploadEdge({
	currentTime,
	mediaEnd,
	paused,
	readyState,
	playerComplete,
}: {
	currentTime: number;
	mediaEnd: number;
	paused: boolean;
	readyState: number;
	playerComplete: boolean;
}): boolean {
	return (
		!playerComplete &&
		!paused &&
		mediaEnd > 0 &&
		readyState < 3 &&
		currentTime >= mediaEnd - 1
	);
}

export function formatClock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const secs = String(whole % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
		: `${minutes}:${secs}`;
}

export function useEarlyPlayback({
	enabled,
	statusUrl,
	playerComplete,
	videoRef,
}: {
	enabled: boolean;
	statusUrl: string | null;
	playerComplete: boolean;
	videoRef: RefObject<HTMLVideoElement | null>;
}): EarlyPlaybackState {
	const [ready, setReady] = useState(0);
	const [recorded, setRecorded] = useState<number | null>(null);
	const [statusComplete, setStatusComplete] = useState(false);
	const [held, setHeld] = useState<number | null>(null);
	const [atEdge, setAtEdge] = useState(false);
	const [stalled, setStalled] = useState(false);
	const uploadComplete = statusComplete || playerComplete;

	const readyRef = useRef(0);
	const recordedRef = useRef<number | null>(null);
	const uploadCompleteRef = useRef(uploadComplete);
	const playerCompleteRef = useRef(playerComplete);
	const heldRef = useRef<number | null>(null);
	const resumeAfterHoldRef = useRef(false);
	const pausedByHoldRef = useRef(false);
	const lastGrowthRef = useRef(Date.now());
	const resolveHoldRef = useRef<() => void>(() => {});
	uploadCompleteRef.current = uploadComplete;
	playerCompleteRef.current = playerComplete;

	useEffect(() => {
		if (!enabled || !statusUrl || uploadComplete) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const response = await fetch(statusUrl, {
					cache: "no-store",
					credentials: "same-origin",
					signal: controller.signal,
				});
				void response.body?.cancel().catch(() => {});
				const status = parseEarlyPlaybackStatus(response);
				if (status) {
					if (status.ready !== null && status.ready > readyRef.current) {
						readyRef.current = status.ready;
						lastGrowthRef.current = Date.now();
						setReady(status.ready);
					}
					if (status.recorded !== null) {
						recordedRef.current = status.recorded;
						setRecorded(status.recorded);
					}
					if (status.uploadComplete) {
						uploadCompleteRef.current = true;
						setStatusComplete(true);
					}
				}
			} catch {
				if (controller.signal.aborted) return;
			}
			setStalled(
				!uploadCompleteRef.current &&
					Date.now() - lastGrowthRef.current > STALLED_AFTER_MS,
			);
			resolveHoldRef.current();
			if (!uploadCompleteRef.current && !controller.signal.aborted)
				timer = setTimeout(poll, STATUS_POLL_MS);
		};
		void poll();
		return () => {
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [enabled, statusUrl, uploadComplete]);

	useEffect(() => {
		if (uploadComplete) setStalled(false);
	}, [uploadComplete]);

	useEffect(() => {
		const video = videoRef.current;
		if (!enabled || !video) return;
		const descriptor = Object.getOwnPropertyDescriptor(
			HTMLMediaElement.prototype,
			"currentTime",
		);
		const getTime = descriptor?.get;
		const setTime = descriptor?.set;
		if (!getTime || !setTime) return;
		const currentTime = () => getTime.call(video) as number;
		const seekTo = (time: number) => setTime.call(video, time);

		const releaseHold = () => {
			heldRef.current = null;
			pausedByHoldRef.current = false;
			setHeld(null);
		};
		const resolveHold = () => {
			const target = heldRef.current;
			if (target === null) return;
			const mediaEnd = getMediaEnd(video);
			if (
				!canResolveHold(target, {
					ready: readyRef.current,
					recorded: recordedRef.current,
					mediaEnd,
					uploadComplete: uploadCompleteRef.current,
					playerComplete: playerCompleteRef.current,
				})
			)
				return;
			const resume = resumeAfterHoldRef.current;
			releaseHold();
			seekTo(Math.min(target, Math.max(0, mediaEnd - 0.05)));
			if (resume) void video.play().catch(() => {});
		};
		resolveHoldRef.current = resolveHold;

		const updateEdge = () =>
			setAtEdge(
				isAtUploadEdge({
					currentTime: currentTime(),
					mediaEnd: getMediaEnd(video),
					paused: video.paused,
					readyState: video.readyState,
					playerComplete: playerCompleteRef.current,
				}),
			);

		// Every seek (seek bar, keys, chapters, comments) sets currentTime, so
		// this one property is where a seek past the uploaded part is held.
		if (!playerComplete) {
			Object.defineProperty(video, "currentTime", {
				configurable: true,
				enumerable: true,
				get: currentTime,
				set: (time: number) => {
					if (
						!Number.isFinite(time) ||
						canSeekNow(time, getMediaEnd(video), playerCompleteRef.current)
					) {
						const resume =
							heldRef.current !== null &&
							pausedByHoldRef.current &&
							resumeAfterHoldRef.current;
						if (heldRef.current !== null) releaseHold();
						seekTo(time);
						if (resume) void video.play().catch(() => {});
						return;
					}
					if (heldRef.current === null)
						resumeAfterHoldRef.current = !video.paused;
					heldRef.current = time;
					setHeld(time);
					if (!video.paused) {
						pausedByHoldRef.current = true;
						video.pause();
					}
				},
			});
		}

		const onPlay = () => {
			if (heldRef.current !== null) releaseHold();
			updateEdge();
		};
		const onDurationChange = () => {
			resolveHold();
			updateEdge();
		};
		const events = ["waiting", "playing", "pause", "seeked", "timeupdate"];
		for (const event of events) video.addEventListener(event, updateEdge);
		video.addEventListener("play", onPlay);
		video.addEventListener("durationchange", onDurationChange);
		resolveHold();
		updateEdge();

		return () => {
			for (const event of events) video.removeEventListener(event, updateEdge);
			video.removeEventListener("play", onPlay);
			video.removeEventListener("durationchange", onDurationChange);
			Reflect.deleteProperty(video, "currentTime");
			resolveHoldRef.current = () => {};
		};
	}, [enabled, playerComplete, videoRef]);

	useEffect(() => {
		const video = videoRef.current;
		if (!enabled || !video || playerComplete || recorded === null) return;
		setFullLength(video, recorded);
		return () => setFullLength(video, null);
	}, [enabled, playerComplete, recorded, videoRef]);

	return { ready, recorded, uploadComplete, held, atEdge, stalled };
}
