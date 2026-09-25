import { describe, expect, test } from "bun:test";
import { closesSegment, segmentCuts } from "./hls";

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
