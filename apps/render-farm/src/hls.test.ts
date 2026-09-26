import { describe, expect, test } from "bun:test";
import {
	checkSegmentReport,
	closesSegment,
	segmentCuts,
	segmentKey,
} from "./hls";

// The worker applies `closesSegment` as each GOP finishes; this replays that
// incremental rule so it can be compared with the coordinator's re-derivation.
function workerCuts(keyframes: number[], total: number, segmentFrames: number) {
	const cuts: [number, number][] = [];
	let start = 0;
	for (const boundary of keyframes.filter((key) => key > 0 && key < total)) {
		if (closesSegment(start, boundary, segmentFrames)) {
			cuts.push([start, boundary]);
			start = boundary;
		}
	}
	cuts.push([start, total]);
	return cuts;
}

describe("segmentCuts", () => {
	test("cuts every other GOP for 2 s GOPs and 4 s segments", () => {
		expect(segmentCuts([0, 60, 120, 180, 240], 300, 120)).toEqual([
			[0, 120],
			[120, 240],
			[240, 300],
		]);
	});

	test("a chunk shorter than one segment is a single segment", () => {
		expect(segmentCuts([0], 45, 60)).toEqual([[0, 45]]);
	});

	test("segments cover the chunk exactly and start on keyframes", () => {
		const keyframes = [0, 60, 120, 150, 210, 300, 330];
		const cuts = segmentCuts(keyframes, 360, 60);
		expect(cuts[0]?.[0]).toBe(0);
		expect(cuts.at(-1)?.[1]).toBe(360);
		for (const [index, [start, end]] of cuts.entries()) {
			expect(end).toBeGreaterThan(start);
			expect(keyframes).toContain(start);
			if (index > 0) expect(start).toBe(cuts[index - 1]?.[1] ?? -1);
		}
	});

	test("matches the worker's incremental rule for irregular keyframes", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		for (let run = 0; run < 200; run++) {
			const total = 30 + Math.floor(random() * 2000);
			const keyframes = [0];
			while ((keyframes.at(-1) ?? 0) < total) {
				keyframes.push((keyframes.at(-1) ?? 0) + 1 + Math.floor(random() * 90));
			}
			const segmentFrames = 30 + Math.floor(random() * 120);
			expect(segmentCuts(keyframes, total, segmentFrames)).toEqual(
				workerCuts(keyframes, total, segmentFrames),
			);
		}
	});
});

describe("checkSegmentReport", () => {
	const chunk = {
		index: 3,
		frames: [90, 150] as [number, number],
		firstPart: 40,
		partLimit: 10,
		dispatches: 2,
	};
	const report = (overrides: Record<string, unknown> = {}) => ({
		chunk: 3,
		index: 1,
		frames: [120, 150],
		key: segmentKey("hls/job", 3, 50, 1),
		last: true,
		extradata: "",
		...overrides,
	});

	test("accepts a segment from any dispatched range of the chunk", () => {
		expect(checkSegmentReport(report(), "hls/job", chunk)).not.toBeNull();
		expect(
			checkSegmentReport(
				report({ key: segmentKey("hls/job", 3, 40, 1) }),
				"hls/job",
				chunk,
			),
		).not.toBeNull();
	});

	test.each([
		["a key outside the job", { key: "out/other-job.mp4" }],
		["a range not yet dispatched", { key: segmentKey("hls/job", 3, 60, 1) }],
		["another chunk's key", { key: segmentKey("hls/job", 2, 40, 1) }],
		["a key for another index", { key: segmentKey("hls/job", 3, 40, 0) }],
		["another chunk", { chunk: 2 }],
		["frames outside the chunk", { frames: [60, 120] }],
		["empty frames", { frames: [120, 120] }],
		["a fractional index", { index: 1.5 }],
		["a missing last flag", { last: undefined }],
	])("rejects %s", (_, overrides) => {
		expect(checkSegmentReport(report(overrides), "hls/job", chunk)).toBeNull();
	});
});
