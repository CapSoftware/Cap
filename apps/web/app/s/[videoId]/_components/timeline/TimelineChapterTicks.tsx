"use client";

import { memo, useMemo } from "react";
import { fractionInWindow, railLeft } from "./timeline-constants";

export interface TimelineChapter {
	title: string;
	start: number;
}

interface TimelineChapterTicksProps {
	chapters: readonly TimelineChapter[];
	duration: number;
	windowStart: number;
	windowEnd: number;
}

/**
 * Chapter starts as cuts in the film: hairlines through the strip with a small
 * notch on its bottom edge. Sits in its own pointer-transparent layer above the
 * tiles so it never steals a scrub.
 */
export const TimelineChapterTicks = memo(function TimelineChapterTicks({
	chapters,
	duration,
	windowStart,
	windowEnd,
}: TimelineChapterTicksProps) {
	const ticks = useMemo(() => {
		if (!Number.isFinite(duration) || duration <= 0) return [];
		if (windowEnd - windowStart <= 0) return [];
		return chapters
			.filter(
				(chapter) =>
					Number.isFinite(chapter.start) &&
					chapter.start > 0 &&
					chapter.start < duration &&
					chapter.start >= windowStart &&
					chapter.start <= windowEnd,
			)
			.map((chapter) => ({
				key: `${chapter.start}-${chapter.title}`,
				title: chapter.title,
				left: railLeft(
					fractionInWindow(chapter.start, windowStart, windowEnd) * 100,
				),
			}));
	}, [chapters, duration, windowStart, windowEnd]);

	if (!ticks.length) return null;

	return (
		<div aria-hidden className="pointer-events-none absolute inset-0 z-[15]">
			{ticks.map((tick) => (
				<span
					key={tick.key}
					title={tick.title}
					className="absolute inset-y-0 w-px -translate-x-1/2"
					style={{ left: tick.left }}
				>
					<span className="absolute inset-0 bg-gray-12/50" />
					<span className="absolute -bottom-1 left-1/2 h-1.5 w-[3px] -translate-x-1/2 rounded-full bg-gray-9" />
				</span>
			))}
		</div>
	);
});
