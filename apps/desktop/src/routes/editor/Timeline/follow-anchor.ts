export const FOLLOW_STEPS = 8;

/// Where the tracks and ruler are laid out while the timeline follows
/// playback: set once the view starts scrolling, then moved on only when the
/// view has scrolled a step past it or back before it. Null lays them out at
/// the exact scroll position.
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
