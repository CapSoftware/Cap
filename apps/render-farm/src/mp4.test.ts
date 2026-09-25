import { describe, expect, test } from "bun:test";
import {
	ANNEX_B_PARAMETER_SETS,
	child,
	parseBoxes,
	u32,
	u64,
} from "./boxes.test-util";
import { avcC, buildHeader, byteRangeFor, type TrackIndex } from "./mp4";

function syntheticIndex(samples: number, gop: number): TrackIndex {
	const times = new Float64Array(samples);
	const offsets = new Float64Array(samples);
	const sizes = new Uint32Array(samples);
	const keyframes: number[] = [];
	let offset = 48;
	for (let sample = 0; sample < samples; sample++) {
		times[sample] = sample / 30 + (sample % 7) * 0.0001;
		sizes[sample] = 1000 + ((sample * 7919) % 5000);
		offsets[sample] = offset;
		offset += sizes[sample] ?? 0;
		if (sample % gop === 0) keyframes.push(sample);
	}
	return {
		timescale: 30_000,
		times,
		offsets,
		sizes,
		keyframes: Uint32Array.from(keyframes),
	};
}

// The linear scan byteRangeFor used before the binary search.
function referenceRange(index: TrackIndex, from: number, to: number) {
	const count = index.times.length;
	let first = 0;
	for (const key of index.keyframes) {
		if ((index.times[key] ?? 0) <= from) first = key;
		else break;
	}
	let last = count - 1;
	for (let sample = first; sample < count; sample++) {
		if ((index.times[sample] ?? 0) > to) {
			last = sample;
			break;
		}
	}
	let start = Number.POSITIVE_INFINITY;
	let end = 0;
	for (let sample = first; sample <= last; sample++) {
		const offset = index.offsets[sample] ?? 0;
		start = Math.min(start, offset);
		end = Math.max(end, offset + (index.sizes[sample] ?? 0));
	}
	return { start, end };
}

describe("byteRangeFor", () => {
	test("matches a linear scan across the whole file", () => {
		const index = syntheticIndex(6000, 21);
		for (let from = -1; from < 205; from += 0.37) {
			for (const span of [0, 0.5, 2, 9]) {
				expect(byteRangeFor(index, from, from + span)).toEqual(
					referenceRange(index, from, from + span),
				);
			}
		}
	});

	test("starts at the keyframe at or before the requested time", () => {
		const index = syntheticIndex(300, 30);
		const range = byteRangeFor(index, 2.5, 2.6);
		expect(range?.start).toBe(index.offsets[60]);
	});

	test("an empty track has no range", () => {
		expect(
			byteRangeFor(
				{
					timescale: 1,
					times: new Float64Array(),
					offsets: new Float64Array(),
					sizes: new Uint32Array(),
					keyframes: new Uint32Array(),
				},
				0,
				1,
			),
		).toBeNull();
	});
});

describe("buildHeader", () => {
	test("lays out ftyp, moov, padding and a 64-bit mdat header", () => {
		const header = buildHeader({
			width: 1920,
			height: 1080,
			fps: 30,
			video: {
				sizes: Uint32Array.from([100, 200, 300]),
				runs: [{ first: 0, count: 3, offset: 0 }],
				keyframes: Uint32Array.from([0]),
				avcC: avcC(ANNEX_B_PARAMETER_SETS),
			},
			audio: {
				sizes: Uint32Array.from([10, 10]),
				runs: [{ first: 0, count: 2, offset: 600 }],
				asc: Uint8Array.of(0x11, 0x90),
				totalSamples: 1024,
				priming: 1024,
			},
			payloadSize: 620,
			minimumSize: 64 * 1024,
		});
		expect(header.byteLength).toBe(64 * 1024);
		const boxes = parseBoxes(header);
		expect(boxes.map((box) => box.type)).toEqual([
			"ftyp",
			"moov",
			"free",
			"mdat",
		]);
		const mdat = boxes[3];
		expect(u32(header, mdat?.start ?? 0)).toBe(1);
		expect(u64(header, (mdat?.start ?? 0) + 8)).toBe(16 + 620);
		const moov = boxes[1];
		if (!moov) throw new Error("no moov");
		const traks = parseBoxes(moov.body).filter((box) => box.type === "trak");
		expect(traks).toHaveLength(2);
		const stbl = child(
			child(child(traks[0] ?? moov, "mdia") ?? moov, "minf") ?? moov,
			"stbl",
		);
		const co64 = stbl && child(stbl, "co64");
		expect(co64 && u64(co64.body, 8)).toBe(header.byteLength);
	});
});
