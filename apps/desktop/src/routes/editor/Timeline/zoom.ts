// Zoom is the number of seconds the timeline shows, so every control scales it
// by a factor: the same gesture or step moves as far through a 2 hour
// recording as through a 30 second one.

export const ZOOM_STEP = 1.5;

// Trackpad pinches arrive as many small ctrl+wheel deltas; a mouse wheel
// notch is one large one, capped so it can't jump the whole range.
const PINCH_RATE = 0.012;
const PINCH_DELTA_LIMIT = 50;

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

/** How much a ctrl+wheel (pinch) event scales the visible duration. */
export function pinchZoomFactor(deltaY: number) {
	return Math.exp(
		clamp(deltaY, -PINCH_DELTA_LIMIT, PINCH_DELTA_LIMIT) * PINCH_RATE,
	);
}

/** Slider position, 0 fully zoomed out to 1 fully zoomed in, on a log scale. */
export function zoomToSlider(zoom: number, minZoom: number, maxZoom: number) {
	if (maxZoom <= minZoom) return 1;
	return clamp(Math.log(maxZoom / zoom) / Math.log(maxZoom / minZoom), 0, 1);
}

export function sliderToZoom(value: number, minZoom: number, maxZoom: number) {
	if (maxZoom <= minZoom) return maxZoom;
	return maxZoom * (minZoom / maxZoom) ** clamp(value, 0, 1);
}
