import { createMemo } from "solid-js";

type OverlaySegment = {
	enabled: boolean;
	start: number;
	end: number;
	track?: number;
};

type IndexedSegment<T> = { segment: T; index: number };

export function createOverlaySegments<T extends OverlaySegment>(
	segments: () => readonly T[],
	time: () => number,
) {
	const indexed = createMemo<IndexedSegment<T>[]>((previous) =>
		segments().map((segment, index) => {
			const existing = previous?.[index];
			return existing?.segment === segment ? existing : { segment, index };
		}),
	);
	const visible = createMemo(() => {
		const currentTime = time();
		return indexed()
			.filter(
				({ segment }) =>
					segment.enabled &&
					currentTime >= segment.start &&
					currentTime < segment.end,
			)
			.sort(
				(a, b) =>
					(a.segment.track ?? 0) - (b.segment.track ?? 0) || a.index - b.index,
			);
	});
	return { indexed, visible };
}
