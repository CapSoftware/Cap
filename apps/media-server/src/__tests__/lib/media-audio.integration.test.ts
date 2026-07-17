import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkHasAudioTrack,
	extractAudio,
	extractAudioStream,
	getActiveProcessCount,
} from "../../lib/media-audio";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;

async function createHlsFixture(): Promise<string> {
	const dirPath = await mkdtemp(join(tmpdir(), "cap-audio-hls-"));
	const proc = Bun.spawn({
		cmd: [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			join(FIXTURES_DIR, "test-with-audio.mp4"),
			"-c",
			"copy",
			"-hls_time",
			"0.25",
			"-hls_list_size",
			"0",
			"-hls_segment_filename",
			join(dirPath, "segment-%03d.ts"),
			join(dirPath, "manifest.m3u8"),
		],
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		await rm(dirPath, { recursive: true, force: true });
		throw new Error(`Failed to create HLS fixture: ${stderr}`);
	}
	return dirPath;
}

async function readStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalBytes += value.length;
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}

	return output;
}

async function waitForAudioOperations(expectedCount: number) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 5000) {
		if (getActiveProcessCount() === expectedCount) return;
		await Bun.sleep(50);
	}
	throw new Error(
		`Expected ${expectedCount} active audio operations, got ${getActiveProcessCount()}`,
	);
}

function expectMp3(data: Uint8Array) {
	expect(data.length).toBeGreaterThan(0);
	const hasId3Tag = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33;
	const hasMpegSync = data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
	expect(hasId3Tag || hasMpegSync).toBe(true);
}

describe("mediaAudio integration tests", () => {
	describe("checkHasAudioTrack", () => {
		test("detects audio track in video with audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
			expect(hasAudio).toBe(true);
		});

		test("detects no audio track in video without audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_NO_AUDIO);
			expect(hasAudio).toBe(false);
		});

		test("inherits signed queries for relative HLS segments", async () => {
			const dirPath = await createHlsFixture();
			const requests: string[] = [];
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					const url = new URL(request.url);
					requests.push(`${url.pathname}${url.search}`);
					if (
						url.pathname !== "/manifest.m3u8" &&
						url.searchParams.get("token") !== "signed"
					) {
						return new Response("Forbidden", { status: 403 });
					}
					return new Response(Bun.file(join(dirPath, url.pathname.slice(1))));
				},
			});

			try {
				const hasAudio = await checkHasAudioTrack(
					`${server.url}manifest.m3u8?token=signed`,
				);
				expect(hasAudio).toBe(true);
				expect(requests).toContain("/segment-000.ts?token=signed");
			} finally {
				await server.stop(true);
				await rm(dirPath, { recursive: true, force: true });
			}
		});

		test("contains upstream failures without leaking the active operation", async () => {
			const beforeCount = getActiveProcessCount();
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response("Unavailable", { status: 503 }),
			});

			try {
				await expect(
					checkHasAudioTrack(`${server.url}video.mp4`),
				).rejects.toThrow("FFprobe exited");
				await waitForAudioOperations(beforeCount);
			} finally {
				await server.stop(true);
			}
		});
	});

	describe("extractAudio", () => {
		test("extracts audio from video with audio track", async () => {
			const audioData = await extractAudio(TEST_VIDEO_WITH_AUDIO);

			expect(audioData).toBeInstanceOf(Uint8Array);
			expectMp3(audioData);
		});

		test("throws error for video without audio track", async () => {
			await expect(extractAudio(TEST_VIDEO_NO_AUDIO)).rejects.toThrow();
		});
	});

	describe("extractAudioStream", () => {
		test("streams real mp3 data and cleans up its operation", async () => {
			const beforeCount = getActiveProcessCount();
			const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);

			const audioData = await readStream(stream);

			expectMp3(audioData);
			await waitForAudioOperations(beforeCount);
		});

		test("cleans up when a real stream is cancelled", async () => {
			const beforeCount = getActiveProcessCount();
			const { stream } = extractAudioStream(TEST_VIDEO_WITH_AUDIO);

			await stream.cancel();

			await waitForAudioOperations(beforeCount);
		});
	});
});
