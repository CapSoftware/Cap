import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	buildStreamCopySegmentArgs,
	buildTranscodeSegmentArgs,
	normalizeEditRanges,
	renderEditedVideo,
} from "../../lib/media-edit";
import { probeVideo } from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_NO_AUDIO = join(FIXTURES_DIR, "test-no-audio.mp4");

const tempFiles: string[] = [];

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

describe("media edit helpers", () => {
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

	test("merges ranges separated by tiny gaps", () => {
		expect(
			normalizeEditRanges(
				[
					{ start: 0, end: 1 },
					{ start: 1.02, end: 2 },
					{ start: 3, end: 3.02 },
				],
				5,
			),
		).toEqual([{ start: 0, end: 2 }]);
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

describe("renderEditedVideo integration tests", () => {
	test("renders an edited mp4 with audio using the real ffmpeg path", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const progressUpdates: number[] = [];

		const editedFile = await renderEditedVideo({
			inputPath: TEST_VIDEO_WITH_AUDIO,
			keepRanges: [
				{ start: 0, end: 0.4 },
				{ start: 0.55, end: 0.95 },
			],
			metadata,
			onProgress: (progress) => {
				progressUpdates.push(progress);
			},
		});
		tempFiles.push(editedFile.path);

		const outputMetadata = await probeVideo(`file://${editedFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBe("aac");
		expect(outputMetadata.duration).toBeGreaterThan(0.3);
		expect(outputMetadata.duration).toBeLessThan(metadata.duration + 0.2);
		expect(progressUpdates.length).toBeGreaterThan(0);
		expect(progressUpdates.at(-1)).toBe(75);

		await editedFile.cleanup();
	}, 60000);

	test("renders an edited mp4 without adding an audio track", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_NO_AUDIO}`);

		const editedFile = await renderEditedVideo({
			inputPath: TEST_VIDEO_NO_AUDIO,
			keepRanges: [{ start: 0, end: 0.6 }],
			metadata,
		});
		tempFiles.push(editedFile.path);

		const outputMetadata = await probeVideo(`file://${editedFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBeNull();
		expect(outputMetadata.duration).toBeGreaterThan(0.2);
		expect(outputMetadata.duration).toBeLessThan(metadata.duration + 0.2);

		await editedFile.cleanup();
	}, 60000);
});
