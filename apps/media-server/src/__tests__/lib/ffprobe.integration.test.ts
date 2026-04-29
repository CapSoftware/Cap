import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkVideoAccessible, probeVideo } from "../../lib/ffprobe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;

describe("ffprobe integration tests", () => {
	describe("probeVideo", () => {
		test("extracts metadata from video with audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

			expect(metadata).toHaveProperty("duration");
			expect(metadata).toHaveProperty("width");
			expect(metadata).toHaveProperty("height");
			expect(metadata).toHaveProperty("fps");
			expect(metadata).toHaveProperty("videoCodec");
			expect(metadata).toHaveProperty("audioCodec");
			expect(metadata).toHaveProperty("audioChannels");
			expect(metadata).toHaveProperty("sampleRate");
			expect(metadata).toHaveProperty("bitrate");
			expect(metadata).toHaveProperty("fileSize");

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).not.toBeNull();
		});

		test("extracts metadata from video without audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_NO_AUDIO);

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).toBeNull();
			expect(metadata.audioChannels).toBeNull();
			expect(metadata.sampleRate).toBeNull();
		});

		test("throws error for non-existent video", async () => {
			await expect(
				probeVideo("file:///nonexistent/path/to/video.mp4"),
			).rejects.toThrow();
		});

		test("throws error for invalid URL", async () => {
			await expect(
				probeVideo(
					"https://invalid-domain-that-does-not-exist.example/video.mp4",
				),
			).rejects.toThrow();
		});
	});

	describe("checkVideoAccessible", () => {
		test("returns false for non-existent http URL", async () => {
			const accessible = await checkVideoAccessible(
				"https://invalid-domain-that-does-not-exist.example/video.mp4",
			);
			expect(accessible).toBe(false);
		});
	});
});

describe("ffprobe metadata accuracy", () => {
	test("returns correct frame rate format", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(typeof metadata.fps).toBe("number");
		expect(metadata.fps).toBeLessThanOrEqual(240);
		expect(metadata.fps % 1).toBeLessThanOrEqual(0.01);
	});

	test("returns reasonable dimensions", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.width).toBeLessThanOrEqual(4096);
		expect(metadata.height).toBeLessThanOrEqual(4096);
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	test("duration matches expected range for test file", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.duration).toBeGreaterThan(0);
		expect(metadata.duration).toBeLessThan(3600);
	});
});
