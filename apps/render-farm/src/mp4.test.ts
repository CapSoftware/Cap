import { describe, expect, test } from "bun:test";
import {
	ANNEX_B_PARAMETER_SETS,
	child,
	parseBoxes,
	u32,
	u64,
} from "./boxes.test-util";
import {
	avcC,
	buildHeader,
	byteRangeFor,
	indexVideoTrack,
	type TrackIndex,
} from "./mp4";

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

describe("indexVideoTrack", () => {
	const u32s = (...values: number[]) => {
		const bytes = new Uint8Array(values.length * 4);
		const view = new DataView(bytes.buffer);
		for (const [index, value] of values.entries()) {
			view.setUint32(index * 4, value);
		}
		return bytes;
	};
	const box = (type: string, ...payloads: Uint8Array[]) => {
		const size = 8 + payloads.reduce((sum, part) => sum + part.byteLength, 0);
		const bytes = new Uint8Array(size);
		new DataView(bytes.buffer).setUint32(0, size);
		bytes.set(new TextEncoder().encode(type), 4);
		let offset = 8;
		for (const part of payloads) {
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		return bytes;
	};
	const track = (tables: Partial<Record<string, Uint8Array>>) =>
		box(
			"moov",
			box(
				"trak",
				box(
					"mdia",
					box("mdhd", u32s(0, 0, 0, 30, 0, 0)),
					box("hdlr", u32s(0, 0), new TextEncoder().encode("vide")),
					box(
						"minf",
						box(
							"stbl",
							...Object.entries({
								stsz: box("stsz", u32s(0, 0, 3, 10, 20, 30)),
								stts: box("stts", u32s(0, 1, 3, 1)),
								stco: box("stco", u32s(0, 1, 1000)),
								stsc: box("stsc", u32s(0, 1, 1, 3, 1)),
								stss: box("stss", u32s(0, 1, 1)),
								...tables,
							}).map(([, bytes]) => bytes as Uint8Array),
						),
					),
				),
			),
		);

	test("indexes sizes, offsets, times and keyframes", () => {
		const index = indexVideoTrack(track({}));
		expect([...index.sizes]).toEqual([10, 20, 30]);
		expect([...index.offsets]).toEqual([1000, 1010, 1030]);
		expect([...index.times]).toEqual([0, 1 / 30, 2 / 30]);
		expect([...index.keyframes]).toEqual([0]);
	});

	test.each([
		[
			"a uniform sample size with a huge count",
			"video samples",
			{ stsz: box("stsz", u32s(0, 10, 0xffffffff)) },
		],
		[
			"a sample table shorter than its count",
			"stsz lists more entries",
			{ stsz: box("stsz", u32s(0, 0, 1000, 10)) },
		],
		[
			"a chunk offset table shorter than its count",
			"stco lists more entries",
			{ stco: box("stco", u32s(0, 0x7fffffff, 1000)) },
		],
		[
			"a sync sample table shorter than its count",
			"stss lists more entries",
			{ stss: box("stss", u32s(0, 50, 1)) },
		],
	])("rejects %s", (_, message, tables) => {
		expect(() => indexVideoTrack(track(tables))).toThrow(message);
	});

	test("a sample-to-chunk run past the offset table ends at the last chunk", () => {
		const index = indexVideoTrack(
			track({ stsc: box("stsc", u32s(0, 2, 1, 1, 1, 0xfffffff0, 1, 1)) }),
		);
		expect(index.offsets[0]).toBe(1000);
	});
});
