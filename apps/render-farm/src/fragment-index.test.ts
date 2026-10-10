import { describe, expect, test } from "bun:test";
import { fragmentedRecording } from "./boxes.test-util";
import {
	buildPrefix,
	type FragmentedInit,
	FragmentSamples,
	mfraMoofs,
	parseFragmentedInit,
	prefixProvenance,
	readMoof,
	readSps,
	remuxBlocker,
	scanFragments,
	UnsupportedSource,
} from "./fragment-index";
import {
	box,
	build,
	byteRangeFor,
	fullBox,
	indexVideoTrack,
	locateMoov,
} from "./mp4";

function reader(bytes: Uint8Array) {
	const reads: [number, number][] = [];
	const read = async (start: number, endInclusive: number) => {
		reads.push([start, endInclusive]);
		return bytes.slice(start, endInclusive + 1);
	};
	return { read, reads };
}

function initOf(bytes: Uint8Array) {
	const where = locateMoov(bytes, bytes.byteLength) as {
		start: number;
		size: number;
	};
	return parseFragmentedInit(
		bytes.subarray(where.start, where.start + where.size),
		where.start,
	) as FragmentedInit;
}

async function place(bytes: Uint8Array, options = {}) {
	const init = initOf(bytes);
	const { read, reads } = reader(bytes);
	const scan = await scanFragments(read, bytes.byteLength, init, options);
	const built = buildPrefix(init, scan.samples, {
		version: 1,
		source: "owner/video/raw-upload.mp4",
		size: bytes.byteLength,
	});
	return { init, scan, reads, ...built };
}

describe("fragment index", () => {
	test("indexes every video sample where it sits in the recording", async () => {
		const recording = fragmentedRecording({
			frames: 95,
			gop: 30,
			audio: true,
			mfra: true,
		});
		const { scan, bytes, index } = await place(recording.bytes);
		expect(scan).toMatchObject({ fragments: 4, usedMfra: true });
		expect(index.sizes.length).toBe(95);
		expect([...index.keyframes]).toEqual([0, 30, 60, 90]);
		const joined = new Uint8Array(
			bytes.byteLength + recording.bytes.byteLength,
		);
		joined.set(bytes);
		joined.set(recording.bytes, bytes.byteLength);
		for (let frame = 0; frame < 95; frame++) {
			const at = index.offsets[frame] as number;
			const sample = joined.subarray(at, at + (index.sizes[frame] as number));
			expect(sample.byteLength).toBe(recording.size(frame));
			expect(sample.every((value) => value === (frame % 251) + 1)).toBe(true);
			expect(index.times[frame]).toBeCloseTo(frame / 30, 9);
		}
		// The prefix is a regular MP4 header: its own moov indexes the same.
		const where = locateMoov(bytes, bytes.byteLength) as {
			start: number;
			size: number;
		};
		const reread = indexVideoTrack(
			bytes.subarray(where.start, where.start + where.size),
		);
		expect([...reread.offsets]).toEqual([...index.offsets]);
		expect([...reread.sizes]).toEqual([...index.sizes]);
		expect([...reread.keyframes]).toEqual([...index.keyframes]);
		expect([...reread.times]).toEqual([...index.times]);
		expect(prefixProvenance(bytes)).toEqual({
			version: 1,
			source: "owner/video/raw-upload.mp4",
			size: recording.bytes.byteLength,
		});
		// The mdat header claims exactly the source that follows it.
		const view = new DataView(bytes.buffer);
		expect(Number(view.getBigUint64(bytes.byteLength - 8))).toBe(
			16 + recording.bytes.byteLength,
		);
		const range = byteRangeFor(index, 1.5, 2.1) as { start: number };
		expect(range.start).toBe(index.offsets[30] as number);
	});

	test("with an mfra only the moofs are read; without one the file streams", async () => {
		const withMfra = fragmentedRecording({
			frames: 3000,
			gop: 300,
			mfra: true,
		});
		const listed = await place(withMfra.bytes, {
			concurrency: 4,
			tailBytes: 4096,
		});
		// The tail, then one small read per moof.
		const read = listed.reads.reduce(
			(sum, [start, end]) => sum + end - start + 1,
			0,
		);
		expect(listed.scan.usedMfra).toBe(true);
		expect(listed.reads.length).toBe(11);
		expect(read).toBeLessThan(withMfra.bytes.byteLength / 5);

		const bare = fragmentedRecording({ frames: 3000, gop: 300 });
		const streamed = await place(bare.bytes, { piece: 4096, windowPieces: 2 });
		expect(streamed.scan.usedMfra).toBe(false);
		expect(streamed.scan.fragments).toBe(10);
		expect([...streamed.index.sizes]).toEqual([...listed.index.sizes]);
		expect([...streamed.index.keyframes]).toEqual([...listed.index.keyframes]);
	});

	test("fragments an mfra leaves out are found by walking the boxes", async () => {
		const recording = fragmentedRecording({ frames: 120, gop: 30 });
		const init = initOf(recording.bytes);
		// An mfra naming only the first and third moofs.
		const listed = [recording.moofs[0], recording.moofs[2]] as number[];
		const tfra = fullBox(
			"tfra",
			1,
			0,
			build((writer) => {
				writer.u32(1);
				writer.u32(0);
				writer.u32(listed.length);
				for (const moof of listed) {
					writer.u64(0);
					writer.u64(moof);
					writer.u8(1);
					writer.u8(1);
					writer.u8(1);
				}
			}),
		);
		const mfra = box(
			"mfra",
			tfra,
			fullBox(
				"mfro",
				0,
				0,
				build((writer) => writer.u32(8 + tfra.byteLength + 16)),
			),
		);
		const bytes = new Uint8Array(recording.bytes.byteLength + mfra.byteLength);
		bytes.set(recording.bytes);
		bytes.set(mfra, recording.bytes.byteLength);
		expect(mfraMoofs(bytes.subarray(bytes.byteLength - 4096), 1)).toMatchObject(
			{ moofs: listed },
		);
		const scan = await scanFragments(
			async (start, end) => bytes.slice(start, end + 1),
			bytes.byteLength,
			init,
		);
		expect(scan.samples.count).toBe(120);
		expect(scan.fragments).toBe(4);
	});

	test("composition offsets become a ctts and presentation times", () => {
		const recording = fragmentedRecording({ frames: 2, gop: 30 });
		const init = initOf(recording.bytes);
		const samples = new FragmentSamples();
		// moof > traf > tfhd (base is moof, default size 10) + tfdt + trun
		// with durations and signed composition offsets, no data offset.
		const moof = box(
			"moof",
			fullBox(
				"mfhd",
				0,
				0,
				build((writer) => writer.u32(1)),
			),
			box(
				"traf",
				fullBox(
					"tfhd",
					0,
					0x20010,
					build((writer) => {
						writer.u32(1);
						writer.u32(10);
					}),
				),
				fullBox(
					"tfdt",
					1,
					0,
					build((writer) => writer.u64(0)),
				),
				fullBox(
					"trun",
					1,
					0x900,
					build((writer) => {
						writer.u32(3);
						for (const [duration, offset] of [
							[1000, 2000],
							[1000, -1000],
							[1000, 0],
						]) {
							writer.u32(duration as number);
							writer.u32(offset as number);
						}
					}),
				),
			),
		);
		readMoof(moof, 5000, init, samples);
		expect(samples.positions).toEqual([5000, 5010, 5020]);
		expect(samples.offsets).toEqual([2000, -1000, 0]);
		expect(remuxBlocker(init, samples)).toBe(
			"presentation and decode times differ",
		);
		const { bytes, index } = buildPrefix(init, samples, {
			version: 1,
			source: "s",
			size: 6000,
		});
		expect([...index.times]).toEqual([2 / 30, 0, 2 / 30]);
		const text = new TextDecoder("latin1").decode(bytes);
		expect(text.includes("ctts")).toBe(true);
	});

	test("sources a remux wouldn't copy as they are keep the transcode", () => {
		const recording = fragmentedRecording({ frames: 300, gop: 150 });
		const init = initOf(recording.bytes);
		const samples = new FragmentSamples();
		const start = (index: number) => ({
			dts: index * 1000,
			sync: index % 150 === 0,
		});
		for (let index = 0; index < 300; index++) {
			samples.dts.push(start(index).dts);
			samples.offsets.push(0);
			samples.sizes.push(1);
			samples.positions.push(index);
			samples.sync.push(start(index).sync);
		}
		samples.firstDts = 0;
		samples.lastDuration = 1000;
		expect(remuxBlocker(init, samples)).toBe("keyframes too far apart");
		samples.sync = samples.sync.map((_, index) => index % 60 === 0);
		expect(remuxBlocker(init, samples)).toBeNull();
		expect(remuxBlocker({ ...init, codec: "hvc1" }, samples)).toBe(
			"codec hvc1",
		);
		samples.firstDts = 1000;
		expect(() =>
			buildPrefix(init, samples, { version: 1, source: "s", size: 300 }),
		).toThrow(UnsupportedSource);
	});

	test("reads the SPS fields ffmpeg reports", () => {
		const recording = fragmentedRecording({ frames: 1, gop: 1 });
		const init = initOf(recording.bytes);
		const avcC = init.avcC as Uint8Array;
		const length = ((avcC[6] as number) << 8) | (avcC[7] as number);
		expect(readSps(avcC.subarray(8, 8 + length))).toMatchObject({
			profile: 100,
			chromaFormat: 1,
			lumaDepth: 8,
			chromaDepth: 8,
		});
	});

	test("a moov with no mvex is not a fragmented recording", () => {
		const moov = box("moov", fullBox("mvhd", 0, 0, new Uint8Array(96)));
		expect(parseFragmentedInit(moov, 0)).toBeNull();
	});
});
