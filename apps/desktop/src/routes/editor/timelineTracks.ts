import type { OverlayTrack, OverlayTrackKind } from "~/utils/tauri";

export type { OverlayTrack, OverlayTrackKind } from "~/utils/tauri";

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

// Fits a new segment of `length` into the free gap that contains `time`,
// keeping it as centred on `time` as the gap allows. Returns null when `time`
// sits inside an existing segment or the surrounding gap is too small —
// callers fall back to another lane in that case.
export function placeSegmentAtTime<T extends TrackSegment>(
	segments: T[],
	time: number,
	length: number,
	totalDuration: number,
): { start: number; end: number } | null {
	if (length <= 0 || totalDuration <= 0) return null;

	let gapStart = 0;
	let gapEnd = totalDuration;
	for (const segment of segments) {
		if (segment.start <= time && time < segment.end) return null;
		if (segment.end <= time) gapStart = Math.max(gapStart, segment.end);
		else gapEnd = Math.min(gapEnd, segment.start);
	}

	if (gapEnd - gapStart < length) return null;

	const start = Math.min(
		Math.max(time - length / 2, gapStart),
		gapEnd - length,
	);
	return { start, end: start + length };
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

export function moveTrackLane<T extends TrackSegment>(
	segments: T[],
	from: number,
	to: number,
) {
	if (
		!Number.isInteger(from) ||
		!Number.isInteger(to) ||
		from < 0 ||
		to < 0 ||
		from === to
	)
		return;
	for (const segment of segments) {
		const lane = getSegmentTrack(segment);
		if (lane === from) segment.track = to;
		else if (from < to && lane > from && lane <= to) segment.track = lane - 1;
		else if (from > to && lane >= to && lane < from) segment.track = lane + 1;
	}
}

type OverlayProject = {
	overlayOrder?: OverlayTrack[];
	timeline?: {
		textSegments?: TrackSegment[];
		imageSegments?: TrackSegment[];
		maskSegments?: TrackSegment[];
	} | null;
};

export function isOverlayTrackKind(kind: string): kind is OverlayTrackKind {
	return kind === "text" || kind === "image" || kind === "mask";
}

export function sameOverlayTrack(a: OverlayTrack, b: OverlayTrack) {
	return a.kind === b.kind && a.track === b.track;
}

export function resolveOverlayOrder(
	available: OverlayTrack[],
	saved: OverlayTrack[] = [],
) {
	const ordered: OverlayTrack[] = [];
	for (const track of available) {
		if (
			!saved.some((item) => sameOverlayTrack(item, track)) &&
			!ordered.some((item) => sameOverlayTrack(item, track))
		)
			ordered.push(track);
	}
	for (const track of saved) {
		if (
			available.some((item) => sameOverlayTrack(item, track)) &&
			!ordered.some((item) => sameOverlayTrack(item, track))
		)
			ordered.push(track);
	}
	return ordered;
}

export function getOverlayTrackRows(
	project: OverlayProject,
	counts?: Partial<Record<OverlayTrackKind, number>>,
) {
	const timeline = project.timeline;
	const available: OverlayTrack[] = [];
	for (const kind of ["text", "image", "mask"] as const) {
		const segments = timeline?.[`${kind}Segments`] ?? [];
		for (const track of getTrackRowsWithCount(
			segments,
			counts?.[kind] ?? 0,
		).reverse())
			available.push({ kind, track });
	}
	return resolveOverlayOrder(available, project.overlayOrder);
}

export function moveOverlayTrack(
	order: OverlayTrack[],
	from: OverlayTrack,
	insertionIndex: number,
) {
	if (!Number.isInteger(insertionIndex)) return order;
	const source = order.find((track) => sameOverlayTrack(track, from));
	if (!source) return order;
	const next = order.filter((track) => !sameOverlayTrack(track, from));
	next.splice(Math.max(0, Math.min(next.length, insertionIndex)), 0, source);
	return next;
}

export function removeOverlayTrack(
	order: OverlayTrack[] | undefined,
	kind: OverlayTrackKind,
	lane: number,
) {
	return (order ?? [])
		.filter((track) => track.kind !== kind || track.track !== lane)
		.map((track) =>
			track.kind === kind && track.track > lane
				? { ...track, track: track.track - 1 }
				: track,
		);
}

export function getOverlayZIndex(
	project: OverlayProject,
	kind: OverlayTrackKind,
	track: number,
) {
	const order = getOverlayTrackRows(project);
	const index = order.findIndex(
		(item) => item.kind === kind && item.track === track,
	);
	return 100 + order.length - Math.max(0, index);
}

export function trackInsertionIndex(centers: number[], pointerY: number) {
	const index = centers.findIndex((center) => pointerY < center);
	return index < 0 ? centers.length : index;
}
