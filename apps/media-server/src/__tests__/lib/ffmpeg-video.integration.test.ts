import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	generateThumbnail,
	processVideo,
	processVideoWithTimeline,
} from "../../lib/ffmpeg-video";
import { probeVideo } from "../../lib/ffprobe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const WEB_BACKGROUND = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"web",
	"public",
	"backgrounds",
	"blue",
	"1.jpg",
);

const tempFiles: string[] = [];

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

function samplePixel(
	path: string,
	x: number,
	y: number,
): [number, number, number] {
	const data = execFileSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			path,
			"-vf",
			`format=rgb24,crop=1:1:${x}:${y}`,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"pipe:1",
		],
		{ encoding: "buffer" },
	);

	if (data.length < 3) {
		throw new Error("Failed to read pixel data from output video");
	}

	return [data[0], data[1], data[2]];
}

function colorDistance(
	a: [number, number, number],
	b: [number, number, number],
): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

describe("generateThumbnail integration tests", () => {
	test("generates JPEG thumbnail from video", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);

		expect(thumbnailData[0]).toBe(0xff);
		expect(thumbnailData[1]).toBe(0xd8);
	});

	test("generates thumbnail at specific timestamp", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ timestamp: 0.1 },
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);
	});

	test("generates thumbnail with custom dimensions", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ width: 320, height: 180 },
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);
	});

	test("generates thumbnail with custom quality", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const highQuality = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ quality: 95 },
		);

		const lowQuality = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ quality: 10 },
		);

		expect(highQuality.length).toBeGreaterThanOrEqual(lowQuality.length);
	});

	test("throws error for non-existent video", async () => {
		await expect(
			generateThumbnail("/nonexistent/path/to/video.mp4", 10),
		).rejects.toThrow();
	});
});

describe("processVideo integration tests", () => {
	test("processes video and produces valid output", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		let lastProgress = 0;
		const progressUpdates: number[] = [];

		const tempFile = await processVideo(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			{ maxWidth: 640, maxHeight: 360 },
			(progress, _message) => {
				expect(progress).toBeGreaterThanOrEqual(lastProgress);
				progressUpdates.push(progress);
				lastProgress = progress;
			},
		);

		tempFiles.push(tempFile.path);

		expect(existsSync(tempFile.path)).toBe(true);

		const outputMetadata = await probeVideo(`file://${tempFile.path}`);
		expect(outputMetadata.width).toBeLessThanOrEqual(640);
		expect(outputMetadata.height).toBeLessThanOrEqual(360);
		expect(outputMetadata.videoCodec).toBe("h264");

		expect(progressUpdates.length).toBeGreaterThan(0);
		expect(progressUpdates[progressUpdates.length - 1]).toBeGreaterThanOrEqual(
			50,
		);

		await tempFile.cleanup();
		expect(existsSync(tempFile.path)).toBe(false);
	}, 60000);

	test("respects CRF setting", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const highQualityFile = await processVideo(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			{ crf: 18 },
		);
		tempFiles.push(highQualityFile.path);

		const lowQualityFile = await processVideo(TEST_VIDEO_WITH_AUDIO, metadata, {
			crf: 35,
		});
		tempFiles.push(lowQualityFile.path);

		const highQualityMetadata = await probeVideo(
			`file://${highQualityFile.path}`,
		);
		const lowQualityMetadata = await probeVideo(
			`file://${lowQualityFile.path}`,
		);

		expect(highQualityMetadata.bitrate).toBeGreaterThanOrEqual(
			lowQualityMetadata.bitrate,
		);

		await highQualityFile.cleanup();
		await lowQualityFile.cleanup();
	}, 120000);

	test("throws error for non-existent video", async () => {
		const fakeMetadata = {
			duration: 10,
			width: 1920,
			height: 1080,
			fps: 30,
			videoCodec: "h264",
			audioCodec: null,
			audioChannels: null,
			sampleRate: null,
			bitrate: 5000000,
			fileSize: 0,
		};

		await expect(
			processVideo("/nonexistent/path/to/video.mp4", fakeMetadata, {}),
		).rejects.toThrow();
	});
});

describe("processVideoWithTimeline integration tests", () => {
	test("applies editor background layout with padding, rounding, and shadow", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const output = await processVideoWithTimeline(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			[{ start: 0, end: metadata.duration, timescale: 1 }],
			{
				aspectRatio: "wide",
				background: {
					source: {
						type: "color",
						value: [250, 0, 250],
					},
					padding: 12,
					rounding: 80,
					roundingType: "squircle",
					shadow: 80,
					advancedShadow: {
						size: 60,
						opacity: 80,
						blur: 60,
					},
				},
			},
		);
		tempFiles.push(output.path);

		const outputMetadata = await probeVideo(`file://${output.path}`);
		expect(outputMetadata.width).toBe(428);
		expect(outputMetadata.height).toBe(240);

		const cornerPixel = samplePixel(output.path, 2, 2);
		const roundedInnerCornerPixel = samplePixel(output.path, 45, 27);
		const centerPixel = samplePixel(output.path, 214, 120);

		expect(colorDistance(cornerPixel, [250, 0, 250])).toBeLessThan(90);
		expect(colorDistance(roundedInnerCornerPixel, [250, 0, 250])).toBeLessThan(
			120,
		);
		expect(colorDistance(centerPixel, [250, 0, 250])).toBeGreaterThan(50);

		await output.cleanup();
	});

	test("renders wallpaper assets in editor pipeline", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const output = await processVideoWithTimeline(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			[{ start: 0, end: metadata.duration, timescale: 1 }],
			{
				background: {
					source: {
						type: "wallpaper",
						path: WEB_BACKGROUND,
					},
					padding: 10,
					rounding: 0,
					shadow: 0,
				},
			},
		);
		tempFiles.push(output.path);

		const outputMetadata = await probeVideo(`file://${output.path}`);
		expect(outputMetadata.width).toBe(320);
		expect(outputMetadata.height).toBe(240);

		const cornerPixel = samplePixel(output.path, 2, 2);
		const centerPixel = samplePixel(output.path, 160, 120);

		expect(colorDistance(cornerPixel, centerPixel)).toBeGreaterThan(20);

		await output.cleanup();
	});
});
