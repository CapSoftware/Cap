"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { captureVideoFrameDataUrl } from "../video-frame-thumbnail";
import {
	FILMSTRIP_MAX_HLS_SAMPLES,
	filmstripCaptureOrder,
	filmstripPoolQuantum,
	filmstripWindowTimes,
	nearestPooledTime,
	poolBorrowTolerance,
	quantizePoolTime,
	rememberFrame,
} from "./filmstrip-math";

/**
 * Where the filmstrip's frames come from. `native` is anything a bare
 * `<video>` can decode (the result.mp4 of instant recordings); `hls` playlists
 * go through hls.js, which the share page already ships for those videos.
 */
export interface FilmstripSource {
	src: string;
	kind: "native" | "hls";
}

interface FramePool {
	/** Quantised time -> data URL. */
	frames: Map<number, string>;
	/** Quantised times already attempted, captured or not. */
	settled: Set<number>;
}

/**
 * One pool per source, kept at module level. Frames survive unmounts, view
 * toggles, resizes and zooms: the strip is only ever recomposed from what is
 * already here, so it never visibly regenerates.
 */
const pools = new Map<string, FramePool>();
const POOL_MAX_SOURCES = 6;

const poolFor = (src: string): FramePool => {
	const existing = pools.get(src);
	if (existing) return existing;
	if (pools.size >= POOL_MAX_SOURCES) {
		const oldest = pools.keys().next();
		if (!oldest.done) pools.delete(oldest.value);
	}
	const created: FramePool = { frames: new Map(), settled: new Set() };
	pools.set(src, created);
	return created;
};

/** Debounce before a window change turns into capture work. */
const SETTLE_MS = 300;

function scheduleIdle(callback: () => void, timeout = 800) {
	const idleWindow = window as Window & {
		requestIdleCallback?: (
			callback: () => void,
			options?: { timeout?: number },
		) => number;
		cancelIdleCallback?: (id: number) => void;
	};
	if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
		const id = idleWindow.requestIdleCallback(callback, { timeout });
		return () => idleWindow.cancelIdleCallback?.(id);
	}
	const id = window.setTimeout(callback, 250);
	return () => window.clearTimeout(id);
}

const waitForNextFrame = () =>
	new Promise<void>((resolve) => {
		requestAnimationFrame(() => resolve());
	});

function waitForVideoMetadata(video: HTMLVideoElement) {
	if (video.readyState >= 1) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			video.removeEventListener("loadedmetadata", handleLoaded);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleLoaded = () => settle(true);
		const handleError = () => settle(false);
		timeoutId = window.setTimeout(() => settle(false), 8000);
		video.addEventListener("loadedmetadata", handleLoaded);
		video.addEventListener("error", handleError);
	});
}

function seekForCapture(video: HTMLVideoElement, time: number) {
	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		let frameId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			cancelAnimationFrame(frameId);
			video.removeEventListener("seeked", handleSeeked);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleSeeked = () => settle(true);
		const handleError = () => settle(false);

		timeoutId = window.setTimeout(() => settle(false), 4000);
		video.addEventListener("seeked", handleSeeked);
		video.addEventListener("error", handleError);
		try {
			video.currentTime = time;
			if (video.readyState >= 2 && Math.abs(video.currentTime - time) <= 0.08) {
				frameId = requestAnimationFrame(() => settle(true));
			}
		} catch {
			settle(false);
		}
	});
}

interface HlsLike {
	loadSource(src: string): void;
	attachMedia(video: HTMLVideoElement): void;
	destroy(): void;
}

interface UseFilmstripFramesOptions {
	source: FilmstripSource | null;
	duration: number;
	/** Tiles the strip will render; sampling may be sparser for HLS. */
	tileCount: number;
	/** Tile width / tile height, so captures are cropped once, correctly. */
	tileAspect: number;
	windowStart: number;
	windowEnd: number;
}

export interface FilmstripFrames {
	/** One entry per rendered tile; null while nothing near enough exists yet. */
	tiles: readonly (string | null)[];
}

const EMPTY: FilmstripFrames = { tiles: [] };

/**
 * Lazily builds the strip's frames off a second, muted, invisible video
 * element — never the one the viewer is watching.
 *
 * Captured frames land on a per-source time grid rather than in a per-layout
 * array, so a resize, a zoom or a view toggle recomposes the strip out of the
 * pool immediately and only captures what is genuinely missing. Nothing in
 * here depends on the playback position.
 */
export function useFilmstripFrames({
	source,
	duration,
	tileCount,
	tileAspect,
	windowStart,
	windowEnd,
}: UseFilmstripFramesOptions): FilmstripFrames {
	// Bumped on every capture flush; the tiles memo below reads through it.
	const [poolVersion, setPoolVersion] = useState(0);
	// The capture loop is re-entrant per (src, window, count); everything else
	// (aspect drift from tile rounding) must not restart it.
	const aspectRef = useRef(tileAspect);
	aspectRef.current = tileAspect;

	const src = source?.src ?? null;
	const kind = source?.kind ?? "native";

	useEffect(() => {
		if (!src || tileCount <= 0 || !Number.isFinite(duration) || duration <= 0)
			return;

		const pool = poolFor(src);
		const quantum = filmstripPoolQuantum(duration);
		const full = windowEnd - windowStart >= duration - 0.001;

		let cancelled = false;
		let video: HTMLVideoElement | null = null;
		let hls: HlsLike | null = null;
		let cancelIdle: (() => void) | null = null;

		const cleanupMedia = () => {
			hls?.destroy();
			hls = null;
			if (video) {
				video.removeAttribute("src");
				video.load();
				video = null;
			}
		};

		const missingTimes = (): number[] => {
			const wanted = filmstripWindowTimes(
				tileCount,
				windowStart,
				windowEnd,
				duration,
			);
			const tolerance = poolBorrowTolerance(
				quantum,
				windowEnd - windowStart,
				tileCount,
			);
			const order = full
				? filmstripCaptureOrder(wanted.length)
				: wanted.map((_, index) => index);

			const times: number[] = [];
			const queued = new Set<number>();
			for (const index of order) {
				const time = wanted[index];
				if (time === undefined) continue;
				if (nearestPooledTime(pool.frames.keys(), time, tolerance) !== null)
					continue;
				const slot = quantizePoolTime(time, quantum);
				if (queued.has(slot) || pool.settled.has(slot)) continue;
				queued.add(slot);
				times.push(time);
			}
			return kind === "hls" ? times.slice(0, FILMSTRIP_MAX_HLS_SAMPLES) : times;
		};

		const settleTimer = window.setTimeout(() => {
			const pending = missingTimes();
			if (!pending.length) return;

			cancelIdle = scheduleIdle(() => {
				void (async () => {
					video = document.createElement("video");
					video.crossOrigin = "anonymous";
					video.muted = true;
					video.playsInline = true;
					video.preload = "metadata";

					if (
						kind === "hls" &&
						!video.canPlayType("application/vnd.apple.mpegurl")
					) {
						try {
							const HlsModule = (await import("hls.js")).default;
							if (cancelled || !HlsModule.isSupported()) {
								cleanupMedia();
								return;
							}
							const instance = new HlsModule({
								// A thumbnail run wants one segment around each seek point,
								// not a playback buffer.
								startLevel: 0,
								maxBufferLength: 4,
								maxMaxBufferLength: 8,
								backBufferLength: 0,
							});
							instance.loadSource(src);
							instance.attachMedia(video);
							hls = instance;
						} catch {
							cleanupMedia();
							return;
						}
					} else {
						video.src = src;
						video.load();
					}

					const hasMetadata = await waitForVideoMetadata(video);
					if (cancelled || !hasMetadata) {
						cleanupMedia();
						return;
					}

					const captureWidth = 168;
					const captureHeight = Math.max(
						48,
						Math.round(captureWidth / Math.max(0.5, aspectRef.current)),
					);

					let sinceFlush = 0;
					for (const time of pending) {
						if (cancelled) break;
						const slot = quantizePoolTime(time, quantum);
						if (pool.frames.has(slot)) continue;

						const seeked = await seekForCapture(video, time);
						if (cancelled) break;
						pool.settled.add(slot);
						if (seeked) {
							const frame = captureVideoFrameDataUrl({
								video,
								width: captureWidth,
								height: captureHeight,
								quality: 0.6,
							});
							if (frame) {
								rememberFrame(pool.frames, slot, frame);
								sinceFlush += 1;
								if (sinceFlush >= 3) {
									sinceFlush = 0;
									setPoolVersion((version) => version + 1);
								}
							}
						}
						await waitForNextFrame();
					}

					if (!cancelled && sinceFlush > 0) {
						setPoolVersion((version) => version + 1);
					}
					cleanupMedia();
				})();
			});
		}, SETTLE_MS);

		return () => {
			cancelled = true;
			window.clearTimeout(settleTimer);
			cancelIdle?.();
			cleanupMedia();
		};
	}, [src, kind, tileCount, duration, windowStart, windowEnd]);

	return useMemo<FilmstripFrames>(() => {
		if (!src || tileCount <= 0 || !Number.isFinite(duration) || duration <= 0)
			return EMPTY;

		// poolVersion is the whole point of this dependency: the pool is mutable,
		// so a capture flush is what tells the memo to recompose.
		void poolVersion;

		const pool = pools.get(src);
		const wanted = filmstripWindowTimes(
			tileCount,
			windowStart,
			windowEnd,
			duration,
		);
		if (!pool || pool.frames.size === 0)
			return { tiles: wanted.map(() => null) };

		const tolerance = poolBorrowTolerance(
			filmstripPoolQuantum(duration),
			windowEnd - windowStart,
			tileCount,
		);
		const keys = Array.from(pool.frames.keys());

		return {
			tiles: wanted.map((time) => {
				const slot = nearestPooledTime(keys, time, tolerance);
				return slot === null ? null : (pool.frames.get(slot) ?? null);
			}),
		};
	}, [src, tileCount, duration, windowStart, windowEnd, poolVersion]);
}
