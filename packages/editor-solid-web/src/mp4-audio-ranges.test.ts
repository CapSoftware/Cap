import { describe, expect, test } from "bun:test";
import { box, concat, fullBox, u32 } from "./fragmented-mp4-fixtures";
import {
	coalesceRanges,
	mp4AudioLayout,
	sparseAudioPlan,
} from "./mp4-audio-ranges";

function trak(
	handler: string,
	table: {
		runs: Array<[firstChunk: number, perChunk: number]>;
		sizes: number[];
		offsets: number[];
	},
) {
	return box(
		"trak",
		box(
			"mdia",
			fullBox("hdlr", 0, 0, u32(0), new TextEncoder().encode(handler), u32(0)),
			box(
				"minf",
				box(
					"stbl",
					fullBox(
						"stsc",
						0,
						0,
						u32(table.runs.length),
						...table.runs.flatMap(([first, per]) => [
							u32(first),
							u32(per),
							u32(1),
						]),
					),
					fullBox(
						"stsz",
						0,
						0,
						u32(0),
						u32(table.sizes.length),
						...table.sizes.map(u32),
					),
					fullBox(
						"stco",
						0,
						0,
						u32(table.offsets.length),
						...table.offsets.map(u32),
					),
				),
			),
		),
	);
}

const video = trak("vide", { runs: [[1, 1]], sizes: [5000], offsets: [100] });

describe("mp4AudioLayout", () => {
	test("reads each audio chunk's byte range from the sample table", () => {
		const moov = box(
			"moov",
			video,
			trak("soun", {
				runs: [
					[1, 2],
					[3, 1],
				],
				sizes: [10, 20, 30, 40, 50, 60],
				offsets: [1000, 2000, 3000, 4000],
			}),
		);
		expect(mp4AudioLayout(moov)).toEqual({
			hasVideo: true,
			chunks: [
				{ start: 1000, end: 1030 },
				{ start: 2000, end: 2070 },
				{ start: 3000, end: 3050 },
				{ start: 4000, end: 4060 },
			],
		});
	});

	test("rejects tables that don't add up", () => {
		const moov = box(
			"moov",
			trak("soun", { runs: [[1, 3]], sizes: [1, 2], offsets: [10] }),
		);
		expect(mp4AudioLayout(moov)).toBeNull();
		expect(
			mp4AudioLayout(concat(u32(8), new TextEncoder().encode("free"))),
		).toBeNull();
	});
});

describe("sparseAudioPlan", () => {
	const audio = (chunks: number, spacing: number) =>
		trak("soun", {
			runs: [[1, 1]],
			sizes: Array.from({ length: chunks }, () => 16_000),
			offsets: Array.from(
				{ length: chunks },
				(_, index) => 1000 + index * spacing,
			),
		});

	test("reads only the audio when it comes in large runs", () => {
		const moov = box("moov", video, audio(100, 750_000));
		expect(sparseAudioPlan(moov, 75_000_000)?.length).toBe(100);
	});

	test("reads the whole file when audio is interleaved per frame", () => {
		const moov = box("moov", video, audio(9000, 25_000));
		expect(sparseAudioPlan(moov, 225_000_000)).toBeNull();
	});

	test("leaves audio-only files to the plain stream", () => {
		expect(sparseAudioPlan(box("moov", audio(10, 20_000)), 200_000)).toBeNull();
	});
});

test("coalesceRanges merges ranges within the gap", () => {
	expect(
		coalesceRanges(
			[
				{ start: 0, end: 10 },
				{ start: 15, end: 20 },
				{ start: 100, end: 110 },
			],
			5,
		),
	).toEqual([
		{ start: 0, end: 20 },
		{ start: 100, end: 110 },
	]);
});
