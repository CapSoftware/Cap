export const ZOOM_STEP = 1.5;

const PINCH_RATE = 0.012;
const PINCH_DELTA_LIMIT = 50;

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export function pinchZoomFactor(deltaY: number) {
	return Math.exp(
		clamp(deltaY, -PINCH_DELTA_LIMIT, PINCH_DELTA_LIMIT) * PINCH_RATE,
	);
}

export function zoomToSlider(zoom: number, minZoom: number, maxZoom: number) {
	if (maxZoom <= minZoom) return 1;
	return clamp(Math.log(maxZoom / zoom) / Math.log(maxZoom / minZoom), 0, 1);
}

export function sliderToZoom(value: number, minZoom: number, maxZoom: number) {
	if (maxZoom <= minZoom) return maxZoom;
	return maxZoom * (minZoom / maxZoom) ** clamp(value, 0, 1);
}
