import { describe, expect, it } from "vitest";
import type { KeyboardTrackSegment, SegmentRecordings } from "~/utils/tauri";
import { mapEditedTimeToSource } from "./captions";
import { timelineShiftAfterClipDurationChange } from "./clip-transitions";
import {
	generateForStableKeyboardTimeline,
	mapKeyboardTrackTimes,
	rippleDeleteKeyboardTrack,
	rippleKeyboardTrack,
	splitKeyboardSegment,
} from "./keyboard-timing";
import { defaultTextSegment } from "./text";
import { defaultCamera3DTracks } from "./three-d";
import {
	deleteClipAndRippleAllTracks,
	rippleDeleteAllTracks,
	rippleDeleteFromTrack,
} from "./timeline-utils";

function keyboardSegment(
	start: number,
	end: number,
	displayText: string,
	offsets: number[],
): KeyboardTrackSegment {
	return {
		id: "keyboard-1",
		start,
		end,
		displayText,
		keys: offsets.map((timeOffset, index) => ({
			key: displayText[index] ?? "Key",
			timeOffset,
		})),
	};
}

describe("keyboard output timing", () => {
	it("moves a source-time key at 8s to output time 7s after deleting 5s to 6s", () => {
		const timeline = {
			segments: [{ start: 0, end: 10, timescale: 1 }],
			transitions: [],
			keyboardSegments: [keyboardSegment(8, 9, "a", [0])],
		};

		rippleDeleteAllTracks(timeline, 5, 6);

		expect(timeline.keyboardSegments[0]).toMatchObject({
			start: 7,
			end: 8,
			keys: [{ timeOffset: 0 }],
		});
	});

	it("filters a cut from a one-character-per-key group and rebases later keys", () => {
		const segments = [keyboardSegment(4, 8, "abc", [0, 1500, 2500])];

		rippleDeleteKeyboardTrack(segments, 5, 6);

		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({
			start: 4,
			end: 7,
			displayText: "ac",
			keys: [{ timeOffset: 0 }, { timeOffset: 1500 }],
		});
	});

	it("removes an atomic shortcut instead of corrupting its display text", () => {
		const segment = keyboardSegment(4, 8, "ab", [0, 1500, 2500]);
		segment.displayText = "⌘K";
		const segments = [segment];

		rippleDeleteKeyboardTrack(segments, 5, 6);

		expect(segments).toEqual([]);
	});

	it("scales per-key offsets with a 2x clip speed change", () => {
		const segments = [keyboardSegment(0, 4, "abc", [0, 1000, 2000])];
		const shift = (time: number) =>
			timelineShiftAfterClipDurationChange(time, 0, 0, 0, 4, 2);

		mapKeyboardTrackTimes(segments, (time) => time + shift(time));

		expect(segments[0]).toMatchObject({
			start: 0,
			end: 2,
			keys: [{ timeOffset: 0 }, { timeOffset: 500 }, { timeOffset: 1000 }],
		});
	});

	it("rebases key offsets when a transition changes", () => {
		const segments = [keyboardSegment(4, 7, "ab", [0, 2000])];

		rippleKeyboardTrack(segments, 5, -1);

		expect(segments[0]).toMatchObject({
			start: 4,
			end: 6,
			keys: [{ timeOffset: 0 }, { timeOffset: 1000 }],
		});
	});

	it("leaves a keyboard segment ending at a transition boundary unchanged", () => {
		const segments = [keyboardSegment(4, 5, "a", [0])];

		rippleKeyboardTrack(segments, 5, -1);

		expect(segments[0]).toMatchObject({
			start: 4,
			end: 5,
			keys: [{ timeOffset: 0 }],
		});
	});

	it("maps a retained right tail to the shifted cut end", () => {
		const segments = [keyboardSegment(5.5, 8, "a", [500])];
		const overlays = [{ start: 5.5, end: 8 }];

		rippleDeleteKeyboardTrack(segments, 5, 6, 0.5);
		rippleDeleteFromTrack(overlays, 5, 6, 0.5);

		expect(segments[0]).toMatchObject({
			start: 5.5,
			end: 7.5,
			keys: [{ timeOffset: 0 }],
		});
		expect(overlays).toEqual([{ start: 5.5, end: 7.5 }]);
	});

	it("whole-clip deletion removes holds and uses the actual transition duration", () => {
		const timeline = {
			segments: [
				{ start: 0, end: 4, timescale: 1 },
				{ start: 0, end: 4, timescale: 1 },
				{ start: 0, end: 4, timescale: 1 },
			],
			transitions: [
				{ segmentIndex: 1, type: "cross-fade" as const, duration: 1 },
				{ segmentIndex: 2, type: "cross-fade" as const, duration: 1 },
			],
			textSegments: [
				{ start: 4, end: 5, enabled: true, layout: "fullscreen" as const },
				{ start: 7, end: 8, enabled: true, layout: "fullscreen" as const },
			],
			styleSegments: [{ start: 10, end: 11 }],
			zoomSegments: [{ start: 10, end: 11 }],
			keyboardSegments: [keyboardSegment(3, 9, "abc", [500, 2500, 5500])],
			audioSegments: [{ start: 5, end: 10, trimStart: 2, fadeIn: 1 }],
			maskSegments: [
				{
					start: 5,
					end: 10,
					keyframes: {
						position: [{ time: 1 }, { time: 4 }, { time: 4.5 }],
					},
				},
			],
			camera3dSegments: [
				{ start: 4, end: 5, tracks: defaultCamera3DTracks() },
				{
					start: 10,
					end: 14,
					tracks: {
						...defaultCamera3DTracks(),
						zoom: [{ time: 2, value: 1, outEasing: null, inEasing: null }],
					},
				},
			],
		};

		expect(deleteClipAndRippleAllTracks(timeline, 1)).toBe(true);
		expect(timeline.segments).toHaveLength(2);
		expect(timeline.transitions).toEqual([]);
		expect(timeline.textSegments).toEqual([
			{ start: 4, end: 5, enabled: true, layout: "fullscreen" },
		]);
		expect(timeline.styleSegments).toEqual([{ start: 7, end: 8 }]);
		expect(timeline.zoomSegments).toEqual([{ start: 7, end: 8 }]);
		expect(timeline.keyboardSegments[0]).toMatchObject({
			start: 3,
			end: 6,
			displayText: "ac",
			keys: [{ timeOffset: 500 }, { timeOffset: 2500 }],
		});
		expect(timeline.audioSegments).toEqual([
			{ start: 4, end: 7, trimStart: 4, fadeIn: 0 },
		]);
		expect(timeline.maskSegments[0]).toMatchObject({
			start: 4,
			end: 7,
			keyframes: { position: [{ time: 2 }, { time: 2.5 }] },
		});
		expect(timeline.camera3dSegments).toHaveLength(1);
		expect(timeline.camera3dSegments[0]).toMatchObject({
			start: 7,
			end: 11,
			tracks: { zoom: [{ time: 2, value: 1 }] },
		});
	});

	it("cuts camera keyframes without rescaling retained source timing", () => {
		const tracks = defaultCamera3DTracks();
		tracks.zoom = [
			{
				time: 2,
				value: 2,
				outEasing: [0, 0],
				inEasing: null,
			},
			{
				time: 5,
				value: 5,
				outEasing: [0, 0],
				inEasing: [1, 1],
			},
			{
				time: 8,
				value: 8,
				outEasing: null,
				inEasing: [1, 1],
			},
		];
		const timeline = {
			segments: [{ start: 0, end: 10, timescale: 1 }],
			camera3dSegments: [
				{
					start: 0,
					end: 10,
					tracks,
					transitionIn: 0.2,
					transitionOut: 0.3,
				},
			],
		};

		rippleDeleteAllTracks(timeline, 3, 6);

		expect(timeline.camera3dSegments[0]).toMatchObject({
			start: 0,
			end: 7,
			transitionIn: 0.2,
			transitionOut: 0.3,
			tracks: {
				zoom: [
					{ time: 2, value: 2, outEasing: [0, 0], inEasing: null },
					{ time: 3, value: 3, outEasing: null, inEasing: [1, 1] },
					{ time: 3, value: 6, outEasing: [0, 0], inEasing: null },
					{ time: 5, value: 8, outEasing: null, inEasing: [1, 1] },
				],
			},
		});
	});

	it("retains the last clip", () => {
		const timeline = {
			segments: [{ start: 0, end: 4, timescale: 1 }],
			keyboardSegments: [keyboardSegment(1, 2, "a", [0])],
		};

		expect(deleteClipAndRippleAllTracks(timeline, 0)).toBe(false);
		expect(timeline.segments).toHaveLength(1);
		expect(timeline.keyboardSegments).toHaveLength(1);

		rippleDeleteAllTracks(timeline, 0, 4, 0);
		expect(timeline.segments).toHaveLength(1);
		expect(timeline.keyboardSegments).toHaveLength(1);
	});

	it("manual split partitions generated keys and preserves static segments", () => {
		const generated = keyboardSegment(10, 13, "abc", [0, 1000, 2000]);
		const generatedParts = splitKeyboardSegment(generated, 11, "keyboard-2");
		expect(generatedParts?.[0]).toMatchObject({
			id: "kb-edit-keyboard-1",
			end: 11,
			displayText: "a",
			keys: [{ timeOffset: 0 }],
		});
		expect(generatedParts?.[1]).toMatchObject({
			id: "kb-edit-keyboard-2",
			start: 11,
			displayText: "bc",
			keys: [{ timeOffset: 0 }, { timeOffset: 1000 }],
		});

		const manual = keyboardSegment(10, 13, "Custom", []);
		const manualParts = splitKeyboardSegment(manual, 11, "kb-edit-keyboard-3");
		expect(manualParts?.map((part) => part.id)).toEqual([
			"kb-edit-keyboard-1",
			"kb-edit-keyboard-3",
		]);
		expect(manualParts?.map((part) => part.displayText)).toEqual([
			"Custom",
			"Custom",
		]);
	});

	it("retries generation once when the timeline changes during the command", async () => {
		let signature = "first";
		let callCount = 0;
		const result = await generateForStableKeyboardTimeline(
			() => signature,
			async () => {
				callCount++;
				if (callCount === 1) signature = "second";
				return callCount;
			},
		);

		expect(result).toBe(2);
		expect(callCount).toBe(2);
	});

	it("inverts legacy caption output time through fullscreen holds", () => {
		const hold = {
			...defaultTextSegment(2, 4),
			layout: "fullscreen" as const,
		};
		const recordings = [{ display: { duration: 10 } } as SegmentRecordings];

		expect(
			mapEditedTimeToSource(
				5,
				[{ start: 0, end: 10, timescale: 1 }],
				recordings,
				[],
				undefined,
				"incoming",
				[hold],
			),
		).toBe(3);
	});
});
