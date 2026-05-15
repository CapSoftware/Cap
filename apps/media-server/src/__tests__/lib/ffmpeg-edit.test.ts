import { describe, expect, test } from "bun:test";
import {
	buildStreamCopySegmentArgs,
	buildTranscodeSegmentArgs,
	normalizeEditRanges,
} from "../../lib/ffmpeg-edit";

describe("ffmpeg edit helpers", () => {
	test("normalizes edit ranges", () => {
		expect(
			normalizeEditRanges(
				[
					{ start: 3, end: 5 },
					{ start: -1, end: 0.01 },
					{ start: 8, end: 12 },
				],
				10,
			),
		).toEqual([
			{ start: 3, end: 5 },
			{ start: 8, end: 10 },
		]);
	});

	test("builds stream-copy segment args", () => {
		const args = buildStreamCopySegmentArgs(
			"/input.mp4",
			{
				start: 1,
				end: 3.25,
			},
			"/segment.mp4",
		);

		expect(args).toContain("copy");
		expect(args).toContain("-avoid_negative_ts");
		expect(args).toContain("2.250");
	});

	test("builds no-audio transcode args", () => {
		const args = buildTranscodeSegmentArgs(
			"/input.mp4",
			{ start: 0, end: 1 },
			"/segment.mp4",
			false,
		);

		expect(args).toContain("libx264");
		expect(args).toContain(
			"[0:v:0]fps=30,trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v]",
		);
		expect(args).toContain("-an");
		expect(args).not.toContain("0:a:0?");
	});

	test("builds audio transcode args", () => {
		const args = buildTranscodeSegmentArgs(
			"/input.mp4",
			{ start: 0, end: 1 },
			"/segment.mp4",
			true,
		);

		expect(args).toContain("aac");
		expect(args).toContain(
			"[0:v:0]fps=30,trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=0.000:end=1.000,asetpts=PTS-STARTPTS[a]",
		);
		expect(args).toContain("[a]");
	});
});
