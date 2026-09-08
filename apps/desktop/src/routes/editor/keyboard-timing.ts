import type { KeyboardTrackSegment } from "~/utils/tauri";

type TimelineSignatureInput = {
	segments: Array<{
		start: number;
		end: number;
		timescale: number;
		recordingSegment?: number | null;
	}>;
	transitions?: Array<{
		segmentIndex: number;
		type: string;
		duration: number;
	}> | null;
	textSegments?: Array<{
		start: number;
		end: number;
		enabled?: boolean;
		layout?: string;
	}> | null;
};

function rebaseKeys(
	segment: KeyboardTrackSegment,
	oldStart: number,
	mapTime: (time: number) => number,
) {
	const newStart = mapTime(oldStart);
	for (const key of segment.keys ?? []) {
		key.timeOffset = Math.max(
			0,
			(mapTime(oldStart + key.timeOffset / 1000) - newStart) * 1000,
		);
	}
	segment.start = newStart;
	segment.end = Math.max(newStart, mapTime(segment.end));
}

export function mapKeyboardTrackTimes(
	segments: KeyboardTrackSegment[],
	mapTime: (time: number) => number,
) {
	for (const segment of segments) {
		rebaseKeys(segment, segment.start, mapTime);
	}
}

export function rippleKeyboardTrack(
	segments: KeyboardTrackSegment[],
	boundary: number,
	shift: number,
) {
	for (const segment of segments) {
		if (segment.end <= boundary) continue;
		rebaseKeys(segment, segment.start, (time) =>
			time >= boundary ? time + shift : time,
		);
	}
}

export function rippleDeleteKeyboardTrack(
	segments: KeyboardTrackSegment[],
	cutStart: number,
	cutEnd: number,
	shift = cutEnd - cutStart,
) {
	for (
		let segmentIndex = segments.length - 1;
		segmentIndex >= 0;
		segmentIndex--
	) {
		const segment = segments[segmentIndex];
		if (segment.end <= cutStart) continue;
		if (segment.start >= cutStart && segment.end <= cutEnd) {
			segments.splice(segmentIndex, 1);
			continue;
		}

		const oldStart = segment.start;
		const retained = (segment.keys ?? []).map((key) => {
			const time = oldStart + key.timeOffset / 1000;
			return time < cutStart || time >= cutEnd;
		});
		const removesKeys = retained.some((keep) => !keep);
		const chars = Array.from(segment.displayText);
		if (removesKeys && chars.length !== (segment.keys?.length ?? 0)) {
			segments.splice(segmentIndex, 1);
			continue;
		}
		if (removesKeys) {
			segment.displayText = chars
				.filter((_, index) => retained[index])
				.join("");
		}

		if (segment.start >= cutEnd) {
			segment.start -= shift;
			segment.end -= shift;
		} else if (segment.start < cutStart && segment.end > cutEnd) {
			segment.end -= shift;
		} else if (segment.start < cutStart) {
			segment.end = cutStart;
		} else {
			segment.start = cutEnd - shift;
			segment.end = Math.max(segment.start, segment.end - shift);
		}

		const newStart = segment.start;
		segment.keys = (segment.keys ?? []).flatMap((key, index) => {
			if (!retained[index]) return [];
			const time = oldStart + key.timeOffset / 1000;
			const mapped = time >= cutEnd ? time - shift : time;
			return [{ ...key, timeOffset: Math.max(0, (mapped - newStart) * 1000) }];
		});

		if (
			segment.end <= segment.start ||
			(removesKeys && segment.keys.length === 0)
		) {
			segments.splice(segmentIndex, 1);
		}
	}
}

export function splitKeyboardSegment(
	segment: KeyboardTrackSegment,
	at: number,
	rightId: string,
): [KeyboardTrackSegment, KeyboardTrackSegment] | null {
	if (!Number.isFinite(at) || at <= segment.start || at >= segment.end) {
		return null;
	}

	const left = structuredClone(segment);
	const right = structuredClone(segment);
	if (!left.id.startsWith("kb-edit-")) left.id = `kb-edit-${left.id}`;
	left.end = at;
	right.id = rightId.startsWith("kb-edit-") ? rightId : `kb-edit-${rightId}`;
	right.start = at;

	if (!segment.keys?.length) return [left, right];

	const chars = Array.from(segment.displayText);
	if (chars.length !== segment.keys.length) return null;

	left.keys = [];
	left.displayText = "";
	right.keys = [];
	right.displayText = "";
	for (let index = 0; index < segment.keys.length; index++) {
		const key = segment.keys[index];
		const absolute = segment.start + key.timeOffset / 1000;
		if (absolute < at) {
			left.keys.push({ ...key });
			left.displayText += chars[index];
		} else {
			right.keys.push({
				...key,
				timeOffset: (absolute - at) * 1000,
			});
			right.displayText += chars[index];
		}
	}

	if (left.keys.length === 0 || right.keys.length === 0) return null;
	return [left, right];
}

export function keyboardTimelineSignature(
	timeline: TimelineSignatureInput | null | undefined,
) {
	if (!timeline) return null;
	const segments = timeline.segments
		.map(
			(segment) =>
				`${segment.start}|${segment.end}|${segment.timescale}|${segment.recordingSegment ?? 0}`,
		)
		.join(",");
	const transitions = (timeline.transitions ?? [])
		.map(
			(transition) =>
				`${transition.segmentIndex}|${transition.type}|${transition.duration}`,
		)
		.join(",");
	const holds = (timeline.textSegments ?? [])
		.filter(
			(segment) => segment.enabled !== false && segment.layout === "fullscreen",
		)
		.map((segment) => `${segment.start}|${segment.end}`)
		.join(",");
	return `${segments}@@${transitions}@@${holds}`;
}

export async function generateForStableKeyboardTimeline<T>(
	getTimelineSignature: () => string | null,
	generate: () => Promise<T>,
	maxAttempts = 2,
): Promise<T | null> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const signature = getTimelineSignature();
		if (signature === null) return null;
		const result = await generate();
		if (getTimelineSignature() === signature) return result;
	}
	return null;
}
