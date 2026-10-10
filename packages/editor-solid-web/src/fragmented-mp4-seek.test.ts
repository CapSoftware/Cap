import { describe, expect, test } from "bun:test";
import {
	box,
	concat,
	fragment,
	init,
	recording,
	trak,
	u32,
} from "./fragmented-mp4-fixtures";
import {
	emptyMfra,
	endsWithMfro,
	type FragmentPoint,
	fragmentsIn,
	layoutSize,
	mp4SeekInfo,
	nextFragmentProbe,
	planLayoutRead,
	virtualLayout,
} from "./fragmented-mp4-seek";

describe("mp4SeekInfo", () => {
	test("reads the video track's timing from the init bytes", () => {
		const head = recording(3);
		const info = mp4SeekInfo(head);
		expect(info).toEqual({
			moovEnd: init().byteLength,
			videoTrackId: 2,
			timescale: 15360,
			defaultSampleFlags: 0x10000,
			trackIds: [1, 2],
		});
	});

	test("rejects edit lists and files without mvex", () => {
		expect(mp4SeekInfo(init({ edits: true }))).toBeNull();
		expect(
			mp4SeekInfo(concat(box("ftyp"), box("moov", trak(1, "vide", 90000)))),
		).toBeNull();
		expect(mp4SeekInfo(new Uint8Array(40))).toBeNull();
	});
});

describe("fragmentsIn", () => {
	test("finds fragments from the middle of a window and chains through them", () => {
		const file = recording(6);
		const info = mp4SeekInfo(file);
		if (!info) throw new Error("no info");
		const start = info.moovEnd + 700;
		const { points } = fragmentsIn(file.subarray(start), start, info);
		expect(points.length).toBe(5);
		expect(points.map((point) => point.time)).toEqual([2, 4, 6, 8, 10]);
		expect(points.every((point) => point.keyframe && point.relocatable)).toBe(
			true,
		);
		expect(points.at(-1)?.end).toBe(file.byteLength);
		for (const point of points) {
			expect(
				new TextDecoder().decode(
					file.subarray(point.offset + 4, point.offset + 8),
				),
			).toBe("moof");
		}
	});

	test("stops at a fragment whose mdat header is past the window", () => {
		const file = recording(3);
		const info = mp4SeekInfo(file);
		if (!info) throw new Error("no info");
		const firstEnd = fragmentsIn(file, 0, info).points[0]?.end ?? 0;
		const window = file.subarray(0, firstEnd + 100);
		const { points, resumeAt } = fragmentsIn(window, 0, info);
		expect(points.length).toBe(1);
		expect(resumeAt).toBe(firstEnd);
	});

	test("flags delta-frame starts and absolute data offsets", () => {
		const head = init();
		const info = mp4SeekInfo(head);
		if (!info) throw new Error("no info");
		const bytes = concat(
			head,
			fragment(0, { keyframe: false }),
			fragment(30720, { absoluteBase: true }),
		);
		const { points } = fragmentsIn(bytes, 0, info);
		expect(points.map((point) => [point.keyframe, point.relocatable])).toEqual([
			[false, true],
			[true, false],
		]);
	});

	test("ignores bytes that only look like a moof", () => {
		const head = init();
		const info = mp4SeekInfo(head);
		if (!info) throw new Error("no info");
		const fake = concat(
			u32(64),
			new TextEncoder().encode("moof"),
			new Uint8Array(56),
		);
		const { points } = fragmentsIn(
			concat(fake, new Uint8Array(100)),
			5000,
			info,
		);
		expect(points).toEqual([]);
	});
});

describe("emptyMfra", () => {
	test("is an mfra whose mfro points back at it", () => {
		const mfra = emptyMfra();
		const view = new DataView(mfra.buffer);
		expect(mfra.byteLength).toBe(24);
		expect(view.getUint32(20)).toBe(24);
		expect(endsWithMfro(mfra)).toBe(true);
		expect(endsWithMfro(recording(2))).toBe(false);
	});
});

describe("virtual layouts", () => {
	test("maps reads onto init bytes, the recording and the trailer", () => {
		const initBytes = new Uint8Array([1, 2, 3, 4]);
		const trailer = new Uint8Array([9, 9]);
		const layout = virtualLayout(initBytes, 1000, 1600, trailer);
		expect(layoutSize(layout)).toBe(4 + 600 + 2);
		expect(planLayoutRead(layout, 1, 100)).toMatchObject({
			kind: "bytes",
			start: 1,
			end: 4,
		});
		expect(planLayoutRead(layout, 4, 100)).toEqual({
			kind: "remote",
			start: 4,
			end: 104,
			sourceStart: 1000,
			sourceEnd: 1100,
		});
		expect(planLayoutRead(layout, 500, 1000)).toMatchObject({
			kind: "remote",
			end: 604,
			sourceEnd: 1600,
		});
		expect(planLayoutRead(layout, 604, 10)).toMatchObject({
			kind: "bytes",
			end: 606,
		});
		expect(planLayoutRead(layout, 606, 10)).toBeNull();
	});

	test("a whole-file layout is the file plus its trailer", () => {
		const layout = virtualLayout(null, 0, 500, emptyMfra());
		expect(layoutSize(layout)).toBe(524);
		expect(planLayoutRead(layout, 0, 1000)).toMatchObject({
			kind: "remote",
			sourceStart: 0,
			sourceEnd: 500,
		});
	});
});

describe("nextFragmentProbe", () => {
	const point = (offset: number, time: number): FragmentPoint => ({
		offset,
		time,
		keyframe: true,
		relocatable: true,
		end: offset + 1000,
	});

	test("probes where the target should be, a little early", () => {
		const step = nextFragmentProbe(
			[point(1000, 0), point(101_000_000, 1000)],
			500,
			1_000_000,
		);
		expect("probeAt" in step && step.probeAt).toBe(50_500_500 - 500_000);
	});

	test("finishes once the walk from the fragment before is short", () => {
		const before = point(50_000_000, 499);
		expect(
			nextFragmentProbe(
				[point(1000, 0), before, point(101_000_000, 1000)],
				500,
				1_000_000,
			),
		).toEqual({ done: before });
	});

	test("uses the last fragment for times past it, nothing before the first", () => {
		const last = point(90_000, 7000);
		expect(nextFragmentProbe([point(1000, 0), last], 7100, 1000)).toEqual({
			done: last,
		});
		expect(nextFragmentProbe([point(1000, 5)], 1, 1000)).toEqual({
			done: null,
		});
	});
});
