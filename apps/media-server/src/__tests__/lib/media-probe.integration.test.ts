import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkVideoAccessible, probeVideo } from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO_PATH = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;

async function expectRejected(promise: Promise<unknown>): Promise<void> {
	let rejected = false;
	try {
		await promise;
	} catch {
		rejected = true;
	}
	expect(rejected).toBe(true);
}

describe("mediaProbe integration tests", () => {
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
			await expectRejected(probeVideo("file:///nonexistent/path/to/video.mp4"));
		});

		test("throws error for invalid URL", async () => {
			await expectRejected(
				probeVideo(
					"https://invalid-domain-that-does-not-exist.example/video.mp4",
				),
			);
		});

		test("probes media when HEAD is forbidden but GET is allowed", async () => {
			const videoData = readFileSync(TEST_VIDEO_WITH_AUDIO_PATH);
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					if (request.method === "HEAD") {
						return new Response(null, { status: 403 });
					}

					const range = request.headers.get("range");
					const match = range?.match(/^bytes=(\d+)-(\d*)$/);
					if (match) {
						const start = Number.parseInt(match[1] ?? "0", 10);
						const end = match[2]
							? Number.parseInt(match[2], 10)
							: videoData.length - 1;
						const chunk = videoData.subarray(start, end + 1);

						return new Response(chunk, {
							status: 206,
							headers: {
								"Accept-Ranges": "bytes",
								"Content-Length": chunk.length.toString(),
								"Content-Range": `bytes ${start}-${end}/${videoData.length}`,
								"Content-Type": "video/mp4",
							},
						});
					}

					return new Response(videoData, {
						headers: {
							"Accept-Ranges": "bytes",
							"Content-Length": videoData.length.toString(),
							"Content-Type": "video/mp4",
						},
					});
				},
			});

			try {
				const metadata = await probeVideo(
					`${server.url}video.mp4?Policy=a&Signature=b`,
				);

				expect(metadata.duration).toBeGreaterThan(0);
				expect(metadata.videoCodec).toBeTruthy();
			} finally {
				await server.stop(true);
			}
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

describe("mediaProbe metadata accuracy", () => {
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
