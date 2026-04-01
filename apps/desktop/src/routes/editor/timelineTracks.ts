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
	let maxTrack = -1;
	for (let i = 0; i < segments.length; i++) {
		const track = getSegmentTrack(segments[i]);
		if (track > maxTrack) {
			maxTrack = track;
		}
	}
	return maxTrack + 1;
}

export function getTrackRowsWithCount<T extends TrackSegment>(
	segments: T[],
	count: number,
) {
	let maxRow = count - 1;
	for (let i = 0; i < segments.length; i++) {
		const track = getSegmentTrack(segments[i]);
		if (track > maxRow) {
			maxRow = track;
		}
	}
	if (maxRow < 0) return [];
	const rows = new Array<number>(maxRow + 1);
	for (let i = 0; i <= maxRow; i++) {
		rows[i] = i;
	}
	return rows;
}
