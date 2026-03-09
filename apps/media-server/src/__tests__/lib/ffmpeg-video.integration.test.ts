import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	generateThumbnail,
	normalizeVideoInputExtension,
	processVideo,
	withTimeout,
} from "../../lib/ffmpeg-video";
import { probeVideo } from "../../lib/ffprobe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");

const tempFiles: string[] = [];

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

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
	test("waits for async cleanup before rejecting timed out work", async () => {
		let resolveCleanup: (() => void) | undefined;
		let settled = false;
		const cleanupFinished = new Promise<void>((resolve) => {
			resolveCleanup = resolve;
		});

		const timedOutWork = withTimeout(
			new Promise<never>(() => {}),
			1,
			async () => {
				await cleanupFinished;
			},
		);

		void timedOutWork.catch(() => {
			settled = true;
		});

		await Bun.sleep(25);
		expect(settled).toBe(false);

		resolveCleanup?.();

		await expect(timedOutWork).rejects.toThrow("Operation timed out after 1ms");
		expect(settled).toBe(true);
	});

	test("normalizes input extensions", () => {
		expect(normalizeVideoInputExtension(undefined)).toBe(".mp4");
		expect(normalizeVideoInputExtension("webm")).toBe(".webm");
		expect(normalizeVideoInputExtension(".MOV")).toBe(".mov");
	});

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

	test("processes raw webm input into a valid mp4 output", async () => {
		const rawWebmPath = join(
			FIXTURES_DIR,
			`generated-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`,
		);
		tempFiles.push(rawWebmPath);

		execFileSync("ffmpeg", [
			"-y",
			"-i",
			TEST_VIDEO_WITH_AUDIO,
			"-c:v",
			"libvpx-vp9",
			"-c:a",
			"libopus",
			rawWebmPath,
		]);

		const metadata = await probeVideo(`file://${rawWebmPath}`);
		const tempFile = await processVideo(rawWebmPath, metadata, {});
		tempFiles.push(tempFile.path);

		const outputMetadata = await probeVideo(`file://${tempFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBe("aac");

		await tempFile.cleanup();
	}, 120000);
});
