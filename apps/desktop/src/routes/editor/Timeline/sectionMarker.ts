import type { SegmentRecordings, TimelineSegment } from "~/utils/tauri";

export type SectionMarker = { type: "reset" } | { type: "time"; time: number };

export function getSectionMarker(
	{
		segments,
		i,
		position,
	}: {
		segments: TimelineSegment[];
		i: number;
		position: "left" | "right";
	},
	recordings: SegmentRecordings[],
):
	| ({ type: "dual" } & (
			| { left: SectionMarker; right: null }
			| { left: null; right: SectionMarker }
			| { left: SectionMarker; right: SectionMarker }
	  ))
	| { type: "single"; value: SectionMarker }
	| null {
	const currentSegment = segments[i];
	const recordingDuration =
		recordings[currentSegment.recordingSegment ?? 0].display.duration;

	// Check for trim on left edge of current clip
	if (position === "left") {
		const trimAmount = currentSegment.start;

		// First, check if this is between two clips from same recording (junction)
		if (i > 0) {
			const prevSegment = segments[i - 1];
			if (prevSegment.recordingSegment === currentSegment.recordingSegment) {
				// Same recording - show junction marker if chronological
				const isChronological = prevSegment.end <= currentSegment.start;
				if (isChronological) {
					const timeDiff = currentSegment.start - prevSegment.end;
					return {
						type: "single",
						value:
							timeDiff === 0
								? { type: "reset" }
								: { type: "time", time: timeDiff },
					};
				}
				// Reordered - fall through to check for actual trim
			} else {
				// Different recordings - show dual marker if needed
				const prevRecordingDuration =
					recordings[prevSegment.recordingSegment ?? 0].display.duration;
				const leftTime = prevRecordingDuration - prevSegment.end;
				const rightTime = currentSegment.start;

				const left = leftTime === 0 ? null : { type: "time", time: leftTime };
				const right =
					rightTime === 0 ? null : { type: "time", time: rightTime };

				if (left || right) {
					return { type: "dual", left, right } as any;
				}
				return null;
			}
		}

		// Check if clip is trimmed from start (for any clip position)
		if (trimAmount === 0) return null;

		// Check how much content is actually missing vs covered by other clips
		const otherClipsFromSameRecording = segments.filter(
			(seg, idx) =>
				idx !== i && seg.recordingSegment === currentSegment.recordingSegment,
		);

		let actualMissing = trimAmount;

		if (otherClipsFromSameRecording.length > 0) {
			// Build a coverage map of what's covered in the range [0, trimAmount]
			const ranges: Array<{ start: number; end: number }> = [];

			for (const seg of otherClipsFromSameRecording) {
				// Only consider clips that actually overlap with the missing range
				if (seg.start < trimAmount && seg.end > 0) {
					const rangeStart = Math.max(seg.start, 0);
					const rangeEnd = Math.min(seg.end, trimAmount);
					if (rangeStart < rangeEnd) {
						ranges.push({ start: rangeStart, end: rangeEnd });
					}
				}
			}

			// Sort ranges by start position
			ranges.sort((a, b) => a.start - b.start);

			// Merge overlapping ranges and calculate total coverage
			let totalCovered = 0;
			let currentRange: { start: number; end: number } | null = null;

			for (const range of ranges) {
				if (!currentRange) {
					currentRange = { ...range };
				} else if (range.start <= currentRange.end) {
					// Overlapping or adjacent - merge
					currentRange.end = Math.max(currentRange.end, range.end);
				} else {
					// Non-overlapping - add previous range to total and start new range
					totalCovered += currentRange.end - currentRange.start;
					currentRange = { ...range };
				}
			}

			// Add the last range
			if (currentRange) {
				totalCovered += currentRange.end - currentRange.start;
			}

			actualMissing = trimAmount - totalCovered;
		}

		if (actualMissing <= 0) return null;

		return {
			type: "dual",
			right: { type: "time", time: actualMissing },
			left: null,
		};
	}

	// Check for trim on right edge of current clip
	if (position === "right") {
		const diff = recordingDuration - currentSegment.end;

		if (diff <= 0) return null;

		// First check if next segment is from same recording
		const nextSegment = segments[i + 1];
		if (nextSegment?.recordingSegment === currentSegment.recordingSegment) {
			// If next clip is chronologically after this one, don't show marker
			// (the junction marker will be shown on the left side of the next clip instead)
			if (nextSegment.start >= currentSegment.end) {
				return null;
			}
			// If reordered, fall through to check coverage
		}

		// If there are other clips from the same recording that come BEFORE this clip in the timeline,
		// don't show a marker here - any missing content should be shown on those earlier clips instead
		const hasClipsBeforeInTimeline = segments
			.slice(0, i)
			.some((seg) => seg.recordingSegment === currentSegment.recordingSegment);

		if (hasClipsBeforeInTimeline) {
			return null;
		}

		// Only show marker if this is the LAST (or only) clip from this recording in the timeline
		// Check if content from [currentSegment.end, recordingDuration] is covered by clips AFTER this one
		const clipsAfterInTimeline = segments
			.slice(i + 1)
			.filter(
				(seg) => seg.recordingSegment === currentSegment.recordingSegment,
			);

		if (clipsAfterInTimeline.length === 0) {
			// No clips after, so show the full missing amount
			return {
				type: "dual",
				left: { type: "time", time: diff },
				right: null,
			};
		}

		// Build coverage map for [currentSegment.end, recordingDuration]
		const ranges: Array<{ start: number; end: number }> = [];
		for (const seg of clipsAfterInTimeline) {
			if (seg.end > currentSegment.end && seg.start < recordingDuration) {
				const rangeStart = Math.max(seg.start, currentSegment.end);
				const rangeEnd = Math.min(seg.end, recordingDuration);
				if (rangeStart < rangeEnd) {
					ranges.push({ start: rangeStart, end: rangeEnd });
				}
			}
		}

		if (ranges.length === 0) {
			return {
				type: "dual",
				left: { type: "time", time: diff },
				right: null,
			};
		}

		// Sort and merge overlapping ranges
		ranges.sort((a, b) => a.start - b.start);
		let totalCovered = 0;
		let currentRange: { start: number; end: number } | null = null;

		for (const range of ranges) {
			if (!currentRange) {
				currentRange = { ...range };
			} else if (range.start <= currentRange.end) {
				currentRange.end = Math.max(currentRange.end, range.end);
			} else {
				totalCovered += currentRange.end - currentRange.start;
				currentRange = { ...range };
			}
			A;
		}
		if (currentRange) {
			totalCovered += currentRange.end - currentRange.start;
		}

		const actualMissing = diff - totalCovered;

		if (actualMissing <= 0) return null;

		return {
			type: "dual",
			left: { type: "time", time: actualMissing },
			right: null,
		};
	}

	return null;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	describe("getSectionMarker", () => {
		it("reordered clips with trim - should not show marker on second clip right edge", () => {
			// Scenario: Two clips from same recording, reordered
			// First clip (in timeline): starts at 39s (trimmed), ends at 152s (2m32s)
			// Second clip (in timeline): starts at 0s, ends at 175s (2m55s)
			// Recording duration: let's say 300s (5m)

			const segments = [
				{
					recordingSegment: 0,
					timescale: 1,
					start: 39, // Trimmed 39s from the start
					end: 152,
				},
				{
					recordingSegment: 0, // Same recording!
					timescale: 1,
					start: 0,
					end: 175,
				},
			];

			const recordings = [
				{
					display: {
						duration: 300, // 5 minutes
						width: 1920,
						height: 1080,
						fps: 30,
						start_time: 0,
					},
					camera: {
						duration: 300,
						width: 1920,
						height: 1080,
						fps: 30,
						start_time: 0,
					},
					mic: {
						duration: 300,
						sample_rate: 48000,
						channels: 1,
						start_time: 0,
					},
					system_audio: {
						duration: 300,
						sample_rate: 48000,
						channels: 2,
						start_time: 0,
					},
				},
			];

			// Check right edge of second clip
			const rightMarker = getSectionMarker(
				{ segments, i: 1, position: "right" },
				recordings,
			);

			// Should show marker for content from 175s to 300s = 125s missing
			// Because combined coverage is [0s, 175s] (second clip covers more than first)
			// Missing after second clip: [175s, 300s] = 125s
			console.log("Right marker:", rightMarker);
			expect(rightMarker).toEqual({
				type: "dual",
				left: { type: "time", time: 125 },
				right: null,
			});
		});

		it("playground", () => {
			const actual = getSectionMarker(
				{
					i: 1,
					position: "left",
					segments: [
						{
							recordingSegment: 0,
							timescale: 1,
							start: 0,
							end: 15.791211,
						},
						{
							recordingSegment: 1,
							timescale: 1,
							start: 0,
							end: 15.572943,
						},
					],
				},
				[
					{
						display: {
							duration: 0.1,
							width: 2560,
							height: 1440,
							fps: 18,
							start_time: 0.23584246635437012,
						},
						camera: {
							duration: 15.791211,
							width: 1920,
							height: 1440,
							fps: 24,
							start_time: 0.117255542,
						},
						mic: {
							duration: 15.778333,
							sample_rate: 48000,
							channels: 1,
							start_time: 0.18319392204284668,
						},
						system_audio: {
							duration: 15.673,
							sample_rate: 48000,
							channels: 2,
							start_time: 0.25273895263671875,
						},
					},
					{
						display: {
							duration: 0.083333,
							width: 2560,
							height: 1440,
							fps: 12,
							start_time: 56.754987716674805,
						},
						camera: {
							duration: 15.582943,
							width: 1920,
							height: 1440,
							fps: 24,
							start_time: 56.615435542,
						},
						mic: {
							duration: 15.565,
							sample_rate: 48000,
							channels: 1,
							start_time: 56.69483804702759,
						},
						system_audio: {
							duration: 15.473,
							sample_rate: 48000,
							channels: 2,
							start_time: 56.75214147567749,
						},
					},
				],
			);

			expect(actual).toEqual({
				type: "dual",
				left: { time: -15.691211000000001, type: "time" },
				right: null,
			});
		});
	});
}
