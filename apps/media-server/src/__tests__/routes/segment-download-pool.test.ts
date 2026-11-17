import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	downloadSegmentTracks,
	segmentDownloadConcurrencyFromEnv,
} from "../../routes/video";

let server: ReturnType<typeof Bun.serve>;
let directory: string;
let inFlight = 0;
let peak = 0;
const startedAt = new Map<string, number>();
const finishedAt = new Map<string, number>();

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "segment-pool-"));
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			startedAt.set(name, performance.now());
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 30));
			inFlight--;
			finishedAt.set(name, performance.now());
			return new Response(name, {
				headers: { "Content-Length": String(name.length) },
			});
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await rm(directory, { recursive: true, force: true });
	delete process.env.MEDIA_SERVER_SEGMENT_DOWNLOAD_CONCURRENCY;
});

describe("segment download pool", () => {
	test("reads its concurrency from the environment with a safe default and cap", () => {
		expect(segmentDownloadConcurrencyFromEnv({})).toBe(64);
		expect(
			segmentDownloadConcurrencyFromEnv({
				MEDIA_SERVER_SEGMENT_DOWNLOAD_CONCURRENCY: "48",
			}),
		).toBe(48);
		expect(
			segmentDownloadConcurrencyFromEnv({
				MEDIA_SERVER_SEGMENT_DOWNLOAD_CONCURRENCY: "500",
			}),
		).toBe(64);
		expect(
			segmentDownloadConcurrencyFromEnv({
				MEDIA_SERVER_SEGMENT_DOWNLOAD_CONCURRENCY: "nope",
			}),
		).toBe(64);
	});

	test("downloads video and audio segments from one bounded pool", async () => {
		process.env.MEDIA_SERVER_SEGMENT_DOWNLOAD_CONCURRENCY = "8";
		const base = `http://127.0.0.1:${server.port}`;
		const video = Array.from({ length: 30 }, (_, i) => `${base}/video-${i}`);
		const audio = Array.from({ length: 30 }, (_, i) => `${base}/audio-${i}`);
		const videoDir = join(directory, "video");
		const audioDir = join(directory, "audio");
		await Bun.write(join(videoDir, ".keep"), "");
		await Bun.write(join(audioDir, ".keep"), "");
		const [videoFiles, audioFiles] = await downloadSegmentTracks(
			[
				{ urls: video, dir: videoDir },
				{ urls: audio, dir: audioDir },
			],
			"segment-pool-test",
			5,
			55,
		);
		expect(peak).toBe(8);
		expect(startedAt.get("audio-0")).toBeLessThan(
			finishedAt.get("video-29") ?? 0,
		);
		expect(videoFiles).toHaveLength(30);
		expect(audioFiles).toHaveLength(30);
		expect(videoFiles[0]).toBe(join(videoDir, "segment_001.m4s"));
		expect(audioFiles[29]).toBe(join(audioDir, "segment_030.m4s"));
		expect(await readFile(videoFiles[12], "utf8")).toBe("video-12");
		expect(await readFile(audioFiles[7], "utf8")).toBe("audio-7");
	});
});
