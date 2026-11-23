export const FOLLOW_STEPS = 8;

export function nextFollowAnchor(options: {
	anchor: number | null;
	position: number;
	zoom: number;
	playing: boolean;
	scrolled: boolean;
	zoomChanged: boolean;
}): number | null {
	const { anchor, position, zoom, playing, scrolled, zoomChanged } = options;
	if (!playing || zoomChanged) return null;
	if (anchor === null) return scrolled ? position : null;
	if (position < anchor || position - anchor >= zoom / FOLLOW_STEPS)
		return position;
	return anchor;
}
