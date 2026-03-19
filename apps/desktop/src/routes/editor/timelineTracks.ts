type TrackSegment = {
	start: number;
	end: number;
	track?: number;
};

export function getSegmentTrack<T extends TrackSegment>(segment: T) {
	const value = segment.track;
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

export function sortTrackSegments<T extends TrackSegment>(segments: T[]) {
	segments.sort(
		(a, b) =>
			getSegmentTrack(a) - getSegmentTrack(b) ||
			a.start - b.start ||
			a.end - b.end,
	);
	return segments;
}

export function normalizeTrackSegments<T extends TrackSegment>(segments: T[]) {
	const trackMap = new Map<number, number>();
	for (const segment of sortTrackSegments(segments)) {
		const track = getSegmentTrack(segment);
		if (!trackMap.has(track)) {
			trackMap.set(track, trackMap.size);
		}
		segment.track = trackMap.get(track) ?? 0;
	}
	return sortTrackSegments(segments);
}

export function getTrackRows<T extends TrackSegment>(segments: T[]) {
	return getTrackRowsWithCount(segments, getUsedTrackCount(segments));
}

export function getUsedTrackCount<T extends TrackSegment>(segments: T[]) {
	if (segments.length === 0) return 0;
	return Math.max(...segments.map((segment) => getSegmentTrack(segment))) + 1;
}

export function getTrackRowsWithCount<T extends TrackSegment>(
	segments: T[],
	count: number,
) {
	const maxRow = Math.max(
		count - 1,
		...segments.map((segment) => getSegmentTrack(segment)),
	);
	if (maxRow < 0) return [];
	return Array.from({ length: maxRow + 1 }, (_, index) => index);
}
