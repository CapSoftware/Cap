"use client";

import { type RefObject, useEffect, useRef } from "react";
import { usePlayback } from "../playback/PlaybackContext";
import { useTimelineWindowRef } from "./TimelineProvider";
import {
	fractionInWindow,
	RAIL_PAD_X,
	usableWidth,
} from "./timeline-constants";

interface TimelinePlayheadProps {
	/** Live band width, kept by the view's ResizeObserver. */
	widthRef: RefObject<number>;
}

/**
 * Rendered exactly once and then never again: the subscriber writes a transform
 * straight to the DOM, so a playing video costs zero React work here — including
 * when a zoom pushes the playhead out of the window and the needle has to
 * disappear. Deliberately unlabelled: the transport clock is the deck's single
 * time readout, and the needle only marks where it is.
 */
export function TimelinePlayhead({ widthRef }: TimelinePlayheadProps) {
	const playback = usePlayback();
	const windowRef = useTimelineWindowRef();
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;

		let visible = true;

		return playback.subscribe((time) => {
			const { start, end } = windowRef.current;
			const fraction = fractionInWindow(time, start, end);
			const inside = fraction >= 0 && fraction <= 1;
			if (inside !== visible) {
				visible = inside;
				root.style.opacity = inside ? "1" : "0";
			}
			if (!inside) return;
			const width = widthRef.current;
			const x = RAIL_PAD_X + fraction * usableWidth(width);
			// The dot is 12px wide and centred; with the rail running edge to edge
			// an unclamped 0%/100% would hang it half outside the card (the grid
			// has no clip — the shelf's cards must escape). Same lean the branch
			// stems make at the extremes.
			const clamped = width > 12 ? Math.min(Math.max(x, 6), width - 6) : x;
			root.style.transform = `translate3d(${clamped}px, 0, 0)`;
		});
	}, [playback, widthRef, windowRef]);

	return (
		<div
			ref={rootRef}
			aria-hidden
			className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0 will-change-transform"
			style={{ transform: "translate3d(0, 0, 0)" }}
		>
			{/* Needle through the filmstrip: dark core, white halo so it reads on
			    any frame underneath. */}
			<div className="absolute inset-y-0 left-0 w-[3px] -translate-x-1/2 rounded-full bg-gray-12 shadow-[0_0_0_1px_rgba(255,255,255,0.85)]" />
			{/* Grab handle straddling the strip's bottom edge, facing the deck. */}
			<div className="absolute bottom-0 left-0 size-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-gray-12 ring-2 ring-white shadow-[0_1px_3px_rgba(18,22,31,0.25)]" />
		</div>
	);
}
