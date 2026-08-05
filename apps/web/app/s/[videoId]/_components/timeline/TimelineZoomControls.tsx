"use client";

import { usePlayback } from "../playback/PlaybackContext";
import { useTimelineActions, useTimelineWindow } from "./TimelineProvider";
import { ZOOM_STEP } from "./timeline-constants";

/**
 * Zoom in, zoom out, and a Fit escape hatch that only exists while there is
 * something to escape from. No percentage readout: the window is legible from
 * the strip itself, and the clock stays the deck's only number.
 */
export function TimelineZoomControls() {
	const playback = usePlayback();
	const { zoomed } = useTimelineWindow();
	const { zoomAtTime, resetZoom } = useTimelineActions();

	const zoom = (factor: number) =>
		zoomAtTime(factor, playback.getCurrentTime());

	// This cluster lives at the end of the docked control bar's row, so it
	// dresses like the player controls beside it.
	return (
		<div className="flex shrink-0 items-center gap-1 pr-4">
			{zoomed && (
				<button
					type="button"
					onClick={resetZoom}
					className="rounded-md px-2 py-1 text-xs font-medium text-gray-10 transition-colors hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
				>
					Fit
				</button>
			)}
			{/* Hidden on phones: the strip pinch-zooms there, and the docked bar
			    needs every pixel. Fit stays — it is the escape hatch after a pinch. */}
			<button
				type="button"
				aria-label="Zoom out"
				onClick={() => zoom(1 / ZOOM_STEP)}
				className="max-sm:hidden flex size-8 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
			>
				<MinusIcon />
			</button>
			<button
				type="button"
				aria-label="Zoom in"
				onClick={() => zoom(ZOOM_STEP)}
				className="max-sm:hidden flex size-8 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
			>
				<PlusIcon />
			</button>
		</div>
	);
}

const MinusIcon = () => (
	<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
		<title>Zoom out</title>
		<rect x="3" y="7.3" width="10" height="1.4" rx="0.7" />
	</svg>
);

const PlusIcon = () => (
	<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
		<title>Zoom in</title>
		<rect x="3" y="7.3" width="10" height="1.4" rx="0.7" />
		<rect x="7.3" y="3" width="1.4" height="10" rx="0.7" />
	</svg>
);
