import type { TimelineSegment } from "../types/project-config";

export function displayToSourceTime(
	displayTime: number,
	segments: TimelineSegment[],
): number {
	let accumulated = 0;

	for (const seg of segments) {
		const segDisplayDuration = (seg.end - seg.start) / seg.timescale;

		if (displayTime <= accumulated + segDisplayDuration) {
			const offsetInSeg = displayTime - accumulated;
			return seg.start + offsetInSeg * seg.timescale;
		}

		accumulated += segDisplayDuration;
	}

	return segments[segments.length - 1]?.end ?? 0;
}

export function sourceToDisplayTime(
	sourceTime: number,
	segments: TimelineSegment[],
): number {
	let displayTime = 0;

	for (const seg of segments) {
		if (sourceTime < seg.start) break;

		if (sourceTime <= seg.end) {
			displayTime += (sourceTime - seg.start) / seg.timescale;
			break;
		}

		displayTime += (seg.end - seg.start) / seg.timescale;
	}

	return displayTime;
}

export function getTotalDisplayDuration(segments: TimelineSegment[]): number {
	return segments.reduce(
		(acc, seg) => acc + (seg.end - seg.start) / seg.timescale,
		0,
	);
}

export function formatTime(seconds: number): string {
	const hrs = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	if (hrs > 0) {
		return `${hrs}:${mins.toString().padStart(2, "0")}:${secs
			.toString()
			.padStart(2, "0")}`;
	}
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}
