"use client";

import { type RefObject, useEffect, useRef } from "react";
import { useTimelineWindowRef } from "./TimelineProvider";
import {
	fractionInWindow,
	GHOST_CARD_WIDTH,
	RAIL_PAD_X,
	timeFromClientX,
	usableWidth,
} from "./timeline-constants";
import { formatClock } from "./timeline-format";
import type { FilmstripFrames } from "./useFilmstripFrames";

interface TimelineHoverGhostProps {
	stripRef: RefObject<HTMLDivElement | null>;
	widthRef: RefObject<number>;
	onAddAtTime: (time: number) => void;
	enabled: boolean;
	/** Same tiles the filmstrip renders; the preview borrows the one under it. */
	filmstrip: FilmstripFrames;
	tileCount: number;
}

/**
 * "You could put a comment here." A preview card that follows the pointer
 * across the strip — the frame under the cursor plus an "Add at" affordance —
 * with direct DOM writes; the only React in the loop is the card's click
 * handler, which reads the time out of a ref.
 *
 * The card opens upward, briefly over the bottom of the video: standard
 * scrub-preview behaviour, and the reason nothing up the band may clip.
 */
export function TimelineHoverGhost({
	stripRef,
	widthRef,
	onAddAtTime,
	enabled,
	filmstrip,
	tileCount,
}: TimelineHoverGhostProps) {
	const windowRef = useTimelineWindowRef();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const cardRef = useRef<HTMLButtonElement | null>(null);
	const imgWrapRef = useRef<HTMLSpanElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const chipRef = useRef<HTMLSpanElement | null>(null);
	const timeRef = useRef(0);

	// The pointer handler reads tiles out of a ref so a capture flush never
	// re-binds the listeners.
	const framesRef = useRef<FilmstripFrames>(filmstrip);
	const tileCountRef = useRef(tileCount);
	useEffect(() => {
		framesRef.current = filmstrip;
		tileCountRef.current = tileCount;
	}, [filmstrip, tileCount]);

	useEffect(() => {
		const strip = stripRef.current;
		const root = rootRef.current;
		const card = cardRef.current;
		const chip = chipRef.current;
		if (!enabled || !strip || !root || !card || !chip) return;

		let lastLabel = "";
		let lastFrameSrc: string | null = null;
		let visible = false;

		const show = (next: boolean) => {
			if (visible === next) return;
			visible = next;
			root.style.opacity = next ? "1" : "0";
		};

		const handleMove = (event: PointerEvent) => {
			// Nodes and cards own their own hover affordances.
			const target = event.target as HTMLElement | null;
			if (target?.closest("[data-timeline-node],[data-timeline-card]")) {
				show(false);
				return;
			}

			const rect = strip.getBoundingClientRect();
			const { start, end } = windowRef.current;
			const time = timeFromClientX(event.clientX, rect, start, end);
			timeRef.current = time;

			const width = widthRef.current;
			const fraction = Math.min(
				1,
				Math.max(0, fractionInWindow(time, start, end)),
			);
			const x = RAIL_PAD_X + fraction * usableWidth(width);
			root.style.transform = `translate3d(${x}px, 0, 0)`;

			// Keep the card inside the band; the connector line stays on the
			// true position, so near an edge the card slides off-centre instead
			// of clipping.
			const half = GHOST_CARD_WIDTH / 2;
			const clampedX = Math.min(Math.max(x, half + 6), width - half - 6);
			card.style.left = `${clampedX - x}px`;

			const label = `Add at ${formatClock(time)}`;
			if (label !== lastLabel) {
				lastLabel = label;
				chip.textContent = label;
			}

			const tiles = framesRef.current.tiles;
			const count = tileCountRef.current;
			const index =
				count > 0 ? Math.min(count - 1, Math.floor(fraction * count)) : -1;
			const src = index >= 0 ? (tiles[index] ?? null) : null;
			if (src !== lastFrameSrc) {
				lastFrameSrc = src;
				const wrap = imgWrapRef.current;
				const img = imgRef.current;
				if (wrap && img) {
					if (src) {
						img.src = src;
						wrap.style.display = "";
					} else {
						wrap.style.display = "none";
					}
				}
			}

			show(true);
		};

		const handleLeave = () => show(false);

		strip.addEventListener("pointermove", handleMove);
		strip.addEventListener("pointerleave", handleLeave);
		return () => {
			strip.removeEventListener("pointermove", handleMove);
			strip.removeEventListener("pointerleave", handleLeave);
		};
	}, [enabled, stripRef, widthRef, windowRef]);

	if (!enabled) return null;

	return (
		<div
			ref={rootRef}
			className="pointer-events-none absolute inset-y-0 left-0 z-30 w-0 opacity-0 transition-opacity duration-150 will-change-transform"
			style={{ transform: "translate3d(-9999px, 0, 0)" }}
		>
			{/* Connector from the card down onto the strip's top edge. */}
			<span
				aria-hidden
				className="absolute left-0 w-px -translate-x-1/2 bg-gray-8"
				style={{ bottom: "100%", height: 10 }}
			/>
			<button
				ref={cardRef}
				type="button"
				tabIndex={-1}
				onClick={() => onAddAtTime(timeRef.current)}
				className="pointer-events-auto absolute bottom-full -translate-x-1/2 overflow-hidden rounded-xl bg-white text-left ring-1 ring-gray-5 shadow-[0_4px_16px_rgba(18,22,31,0.14)] transition-shadow hover:shadow-[0_6px_20px_rgba(18,22,31,0.18)]"
				style={{ marginBottom: 10, width: GHOST_CARD_WIDTH }}
			>
				<span
					ref={imgWrapRef}
					aria-hidden
					className="block h-[70px] w-full bg-gray-3"
					style={{ display: "none" }}
				>
					<img
						ref={imgRef}
						alt=""
						draggable={false}
						className="size-full select-none object-cover"
					/>
				</span>
				<span className="flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-12">
					<span aria-hidden className="text-gray-9">
						+
					</span>
					<span ref={chipRef} className="whitespace-nowrap tabular-nums">
						Add at 0:00
					</span>
				</span>
			</button>
		</div>
	);
}
