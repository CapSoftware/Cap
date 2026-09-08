"use client";

import clsx from "clsx";
import { memo, type RefObject, useCallback, useEffect, useRef } from "react";
import { usePlayback } from "../playback/PlaybackContext";
import { useTimelineActions, useTimelineWindowRef } from "./TimelineProvider";
import { TimelineWaveform } from "./TimelineWaveform";
import {
	fractionInWindow,
	timeFromClientX,
	usableWidth,
} from "./timeline-constants";
import { formatClock } from "./timeline-format";
import type { FilmstripFrames } from "./useFilmstripFrames";

interface TimelineRailProps {
	/** Latest known duration; only used for the ARIA range. */
	duration: number;
	railRef: RefObject<HTMLDivElement | null>;
	filmstrip: FilmstripFrames;
	/** How many tiles the strip renders; frames may be sparser than this. */
	tileCount: number;
	envelope: Float32Array | null;
	windowStart: number;
	windowEnd: number;
}

/**
 * The strip: a filmstrip of preview frames with the audio drawn over it, owning
 * pointer hit-testing for seeking. Playback progress is a subtle wash plus an
 * underline, both driven by one `--p` custom property written straight to the
 * DOM by a playback-store subscriber — the tiles never re-render while the
 * video plays.
 */
export function TimelineRail({
	duration,
	railRef,
	filmstrip,
	tileCount,
	envelope,
	windowStart,
	windowEnd,
}: TimelineRailProps) {
	const playback = usePlayback();
	const windowRef = useTimelineWindowRef();
	const { zoomAtTime, panBy } = useTimelineActions();
	const progressRef = useRef<HTMLDivElement | null>(null);
	const pendingSeekRef = useRef<number | null>(null);
	const seekFrameRef = useRef(0);

	// One finger on touch: a tap seeks on release, a 6px drag starts scrubbing.
	// Two fingers: pinch zooms around the midpoint and the midpoint's travel
	// pans — the only way to pan a zoomed window on touch, since one finger is
	// the scrubber. Mouse and pen keep the immediate seek-on-down behaviour.
	// "spent" is a pinch that lost a finger: the survivor must not scrub.
	const pointersRef = useRef(new Map<number, { x: number; y: number }>());
	const modeRef = useRef<"idle" | "pending" | "scrub" | "pinch" | "spent">(
		"idle",
	);
	const touchDownRef = useRef<{ x: number; time: number } | null>(null);
	const pinchRef = useRef<{ dist: number; midX: number } | null>(null);

	useEffect(() => {
		const progress = progressRef.current;
		const rail = railRef.current;
		if (!progress) return;

		let lastSecond = -1;

		return playback.subscribe((time) => {
			const { start, end } = windowRef.current;
			const fraction = Math.min(
				1,
				Math.max(0, fractionInWindow(time, start, end)),
			);
			progress.style.setProperty("--p", `${fraction * 100}%`);

			if (!rail) return;
			const second = Math.round(time);
			if (second === lastSecond) return;
			lastSecond = second;
			rail.setAttribute("aria-valuenow", String(second));
			rail.setAttribute("aria-valuetext", formatClock(time));
		});
	}, [playback, railRef, windowRef]);

	// Scrubbing lands at most one seek per frame; the media element is slow to
	// honour `currentTime` and a pointermove burst would queue them all up.
	const scheduleSeek = useCallback(
		(time: number) => {
			pendingSeekRef.current = time;
			if (seekFrameRef.current !== 0) return;
			seekFrameRef.current = requestAnimationFrame(() => {
				seekFrameRef.current = 0;
				const next = pendingSeekRef.current;
				pendingSeekRef.current = null;
				if (next !== null) playback.seek(next);
			});
		},
		[playback],
	);

	useEffect(
		() => () => {
			if (seekFrameRef.current !== 0)
				cancelAnimationFrame(seekFrameRef.current);
		},
		[],
	);

	const timeAt = useCallback(
		(clientX: number) => {
			const rail = railRef.current;
			if (!rail) return 0;
			const { start, end } = windowRef.current;
			// The rail spans the full band; timeFromClientX subtracts the pad.
			return timeFromClientX(clientX, rail.getBoundingClientRect(), start, end);
		},
		[railRef, windowRef],
	);

	return (
		<div
			ref={railRef}
			role="slider"
			tabIndex={0}
			aria-label="Seek"
			aria-orientation="horizontal"
			aria-valuemin={0}
			aria-valuemax={Math.max(0, Math.round(duration))}
			aria-valuenow={0}
			data-timeline-rail=""
			className="absolute inset-0 z-10 cursor-pointer touch-none focus-visible:outline-none group"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				pointersRef.current.set(event.pointerId, {
					x: event.clientX,
					y: event.clientY,
				});
				if (pointersRef.current.size === 2) {
					// Second finger: whatever was in flight becomes a pinch.
					const [a, b] = [...pointersRef.current.values()];
					if (a && b) {
						pinchRef.current = {
							dist: Math.max(20, Math.hypot(b.x - a.x, b.y - a.y)),
							midX: (a.x + b.x) / 2,
						};
						modeRef.current = "pinch";
						touchDownRef.current = null;
						pendingSeekRef.current = null;
					}
					return;
				}
				if (pointersRef.current.size > 2) return;
				if (event.pointerType === "touch") {
					// No seek yet: this may become a pinch or stay a tap.
					modeRef.current = "pending";
					touchDownRef.current = {
						x: event.clientX,
						time: timeAt(event.clientX),
					};
				} else {
					modeRef.current = "scrub";
					playback.seek(timeAt(event.clientX));
				}
			}}
			onPointerMove={(event) => {
				const tracked = pointersRef.current.get(event.pointerId);
				if (tracked) {
					tracked.x = event.clientX;
					tracked.y = event.clientY;
				}
				const mode = modeRef.current;
				if (mode === "pinch") {
					const prev = pinchRef.current;
					const rail = railRef.current;
					if (!prev || !rail || pointersRef.current.size < 2) return;
					const [a, b] = [...pointersRef.current.values()];
					if (!a || !b) return;
					const dist = Math.max(20, Math.hypot(b.x - a.x, b.y - a.y));
					const midX = (a.x + b.x) / 2;
					const rect = rail.getBoundingClientRect();
					const factor = dist / prev.dist;
					if (Math.abs(factor - 1) > 0.002) {
						const { start, end } = windowRef.current;
						zoomAtTime(factor, timeFromClientX(prev.midX, rect, start, end));
					}
					const dx = midX - prev.midX;
					const usable = usableWidth(rect.width);
					if (dx !== 0 && usable > 0) {
						// windowRef is written synchronously by zoomAtTime, so the pan
						// reads the post-zoom span.
						const { start, end } = windowRef.current;
						panBy((-dx / usable) * (end - start));
					}
					pinchRef.current = { dist, midX };
					return;
				}
				if (mode === "pending") {
					const down = touchDownRef.current;
					if (down && Math.abs(event.clientX - down.x) > 6) {
						modeRef.current = "scrub";
						touchDownRef.current = null;
						playback.seek(timeAt(event.clientX));
					}
					return;
				}
				if (mode === "scrub") scheduleSeek(timeAt(event.clientX));
			}}
			onPointerUp={(event) => {
				pointersRef.current.delete(event.pointerId);
				if (event.currentTarget.hasPointerCapture(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
				const mode = modeRef.current;
				if (mode === "pinch") {
					pinchRef.current = null;
					modeRef.current = pointersRef.current.size > 0 ? "spent" : "idle";
					return;
				}
				if (mode === "pending" && touchDownRef.current) {
					playback.seek(touchDownRef.current.time);
				}
				touchDownRef.current = null;
				if (pointersRef.current.size === 0) modeRef.current = "idle";
			}}
			onPointerCancel={(event) => {
				pointersRef.current.delete(event.pointerId);
				pinchRef.current = null;
				touchDownRef.current = null;
				if (pointersRef.current.size === 0) modeRef.current = "idle";
			}}
		>
			<div
				ref={progressRef}
				// Edge to edge and square: the strip is the top of the card's light
				// chrome, so its base is a quiet gray the frames land on and the dark
				// waveform reads over even before any frame has been captured.
				// Focus feedback is an inset ring, corners having gone.
				className="relative h-full overflow-hidden bg-gray-3 group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-blue-9"
			>
				<FilmstripTiles tileCount={tileCount} tiles={filmstrip.tiles} />

				<TimelineWaveform
					envelope={envelope}
					start={windowStart}
					end={windowEnd}
					duration={duration}
				/>

				{/* Played wash: barely-there shade so progress reads on the film
				    without hiding it. Driven by --p, no React involved. */}
				<div
					aria-hidden
					className="absolute inset-0 bg-gray-12/10"
					style={{ clipPath: "inset(0 calc(100% - var(--p, 0%)) 0 0)" }}
				/>
				{/* Progress underline along the strip's bottom edge. */}
				<div
					aria-hidden
					className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-gray-12"
					style={{ clipPath: "inset(0 calc(100% - var(--p, 0%)) 0 0)" }}
				/>
			</div>
		</div>
	);
}

/**
 * The tiles. Memoised on the tiles array, which only changes on a capture flush
 * or a window move — playback and hover cost this component nothing.
 *
 * Deliberately washed out: the film is texture here, and the waveform drawn over
 * it is the layer meant to be read. A white veil rather than a dark one, so the
 * strip stays part of the card's light chrome whatever the footage looks like.
 */
const FilmstripTiles = memo(function FilmstripTiles({
	tileCount,
	tiles,
}: {
	tileCount: number;
	tiles: readonly (string | null)[];
}) {
	return (
		<>
			<div aria-hidden className="absolute inset-0 flex">
				{Array.from({ length: tileCount }, (_, index) => {
					const src = tiles[index] ?? null;
					return (
						<div
							key={index}
							className={clsx(
								"relative h-full min-w-0 flex-1",
								!src && "animate-pulse bg-gray-4",
							)}
						>
							{src && (
								<img
									src={src}
									alt=""
									draggable={false}
									className="absolute inset-0 size-full select-none object-cover opacity-0 brightness-110 saturate-[.7] transition-opacity duration-300"
									onLoad={(event) => {
										event.currentTarget.style.opacity = "1";
									}}
								/>
							)}
						</div>
					);
				})}
			</div>
			{/* Heavier than it looks right in isolation: the waveform drawn over
			    the strip is the layer meant to be read, and busy footage needs
			    this much wash before the bars separate from it. */}
			<div aria-hidden className="absolute inset-0 bg-white/60" />
		</>
	);
});
