import { describe, expect, it } from "vitest";
import {
	FragmentedMp4Error,
	readFragmentDuration,
	readInitTiming,
} from "@/lib/fragmented-mp4-duration";
import {
	initSegment,
	mdat,
	moof,
	rangeReader,
	segment,
} from "../fixtures/fmp4";

describe("readInitTiming", () => {
	it("reads the track timescale and trex default duration", () => {
		expect(
			readInitTiming(
				initSegment({ timescale: 15_360, defaultSampleDuration: 256 }),
			),
		).toEqual({ timescale: 15_360, defaultSampleDuration: 256 });
	});

	it("reads a version 1 mdhd and omits a zero default duration", () => {
		expect(
			readInitTiming(initSegment({ timescale: 48_000, mdhdVersion: 1 })),
		).toEqual({
			timescale: 48_000,
		});
	});

	it("rejects bytes that are not an init segment", () => {
		expect(() =>
			readInitTiming(segment(moof({ durations: [1] }), mdat(4))),
		).toThrow(FragmentedMp4Error);
	});
});

describe("readFragmentDuration", () => {
	it("sums per-sample durations from trun", async () => {
		const bytes = segment(moof({ durations: [512, 512, 1024] }), mdat(1_000));
		const { read } = rangeReader(bytes);
		await expect(
			readFragmentDuration(read, bytes.length, { timescale: 1_024 }),
		).resolves.toBe(2);
	});

	it("falls back to the tfhd default and then the trex default", async () => {
		const fromTfhd = segment(
			moof({ count: 120, tfhdDefaultDuration: 256 }),
			mdat(10),
		);
		await expect(
			readFragmentDuration(rangeReader(fromTfhd).read, fromTfhd.length, {
				timescale: 15_360,
				defaultSampleDuration: 1,
			}),
		).resolves.toBe(2);
		const fromTrex = segment(moof({ count: 94 }), mdat(10));
		await expect(
			readFragmentDuration(rangeReader(fromTrex).read, fromTrex.length, {
				timescale: 48_000,
				defaultSampleDuration: 1_024,
			}),
		).resolves.toBeCloseTo(2.005333, 6);
	});

	it("adds every fragment and skips media data instead of reading it", async () => {
		const bytes = segment(
			moof({ durations: [1_000] }),
			mdat(200_000),
			moof({ durations: [3_000] }),
			mdat(300_000, { large: true }),
		);
		const reader = rangeReader(bytes);
		await expect(
			readFragmentDuration(reader.read, bytes.length, { timescale: 1_000 }),
		).resolves.toBe(4);
		const fetched = reader.reads.reduce(
			(sum, [start, end]) => sum + end - start,
			0,
		);
		expect(fetched).toBeLessThan(200 * 1024);
	});

	it("rejects a fragment whose samples have no duration", async () => {
		const bytes = segment(moof({ count: 3 }), mdat(10));
		await expect(
			readFragmentDuration(rangeReader(bytes).read, bytes.length, {
				timescale: 1_000,
			}),
		).rejects.toThrow("no duration");
	});

	it("rejects a segment cut off inside a box", async () => {
		const bytes = segment(moof({ durations: [1_000] }), mdat(1_000));
		const truncated = bytes.slice(0, bytes.length - 10);
		await expect(
			readFragmentDuration(rangeReader(truncated).read, truncated.length, {
				timescale: 1_000,
			}),
		).rejects.toThrow(FragmentedMp4Error);
	});

	it("rejects a segment without any fragment", async () => {
		const bytes = segment(mdat(10));
		await expect(
			readFragmentDuration(rangeReader(bytes).read, bytes.length, {
				timescale: 1_000,
			}),
		).rejects.toThrow("no moof");
	});
});
