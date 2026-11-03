import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	downloadVideoToTemp,
	LOOM_IMPORT_MAX_BYTES,
} from "../../lib/media-video";

const originalFetch = globalThis.fetch;
const originalDownloadConcurrency =
	process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY;

function stubFetch(response: () => Promise<Response>) {
	globalThis.fetch = Object.assign(response, {
		preconnect: originalFetch.preconnect,
	});
}

describe("Loom import file size", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalDownloadConcurrency === undefined) {
			delete process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY;
		} else {
			process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY =
				originalDownloadConcurrency;
		}
	});

	test("permits exactly the configured boundary", async () => {
		expect(LOOM_IMPORT_MAX_BYTES).toBe(10 * 1024 ** 3);
		stubFetch(async () => new Response(new Uint8Array(16)));
		const result = await downloadVideoToTemp(
			"https://source.test/video.mp4",
			".mp4",
			undefined,
			16,
		);
		try {
			expect(Bun.file(result.path).size).toBe(16);
		} finally {
			await result.cleanup();
		}
	});

	test("rejects an oversized declared body before reading it", async () => {
		let cancelled = false;
		stubFetch(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Length": "17" } },
				),
		);
		await expect(
			downloadVideoToTemp(
				"https://source.test/video.mp4",
				".mp4",
				undefined,
				16,
			),
		).rejects.toThrow("10 GB");
		expect(cancelled).toBe(true);
	});

	test.each([
		["bounded Loom downloads", 16, 30 * 60 * 1000],
		["ordinary downloads", undefined, 10 * 60 * 1000],
	])("keeps the expected timeout for %s", async (_, maxBytes, timeoutMs) => {
		const timeoutSpy = spyOn(AbortSignal, "timeout");
		stubFetch(async () => new Response(new Uint8Array(16)));
		try {
			const result = await downloadVideoToTemp(
				"https://source.test/video.mp4",
				".mp4",
				undefined,
				maxBytes,
			);
			try {
				expect(timeoutSpy).toHaveBeenCalledWith(timeoutMs);
			} finally {
				await result.cleanup();
			}
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	test("enforces the import limit when parallel downloads are enabled", async () => {
		process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY = "4";
		stubFetch(async () => new Response(new Uint8Array(17)));
		await expect(
			downloadVideoToTemp(
				"https://source.test/video.mp4",
				".mp4",
				undefined,
				16,
			),
		).rejects.toThrow("10 GB");
	});

	test("cancels a chunked transfer when it exceeds the limit", async () => {
		let cancelled = false;
		stubFetch(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(8));
							controller.enqueue(new Uint8Array(9));
						},
						cancel() {
							cancelled = true;
						},
					}),
				),
		);
		await expect(
			downloadVideoToTemp(
				"https://source.test/video.mp4",
				".mp4",
				undefined,
				16,
			),
		).rejects.toThrow("10 GB");
		expect(cancelled).toBe(true);
	});

	test("rejects an oversized real HLS recording without returning truncated media", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cap-loom-limit-"));
		let server: ReturnType<typeof Bun.serve> | undefined;
		try {
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=64x64:rate=10",
				"-t",
				"2",
				"-c:v",
				"libx264",
				"-g",
				"10",
				"-f",
				"hls",
				"-hls_time",
				"1",
				"-hls_segment_filename",
				join(directory, "segment%d.ts"),
				join(directory, "index.m3u8"),
			]);
			globalThis.fetch = originalFetch;
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const path = new URL(request.url).pathname;
					return /^\/(?:index\.m3u8|segment\d+\.ts)$/.test(path)
						? new Response(Bun.file(join(directory, path.slice(1))))
						: new Response(null, { status: 404 });
				},
			});
			const source = `${server.url}index.m3u8`;
			const complete = await downloadVideoToTemp(
				source,
				".m3u8",
				undefined,
				1024 ** 2,
			);
			try {
				expect(Bun.file(complete.path).size).toBeGreaterThan(1);
			} finally {
				await complete.cleanup();
			}
			await expect(
				downloadVideoToTemp(source, ".m3u8", undefined, 1),
			).rejects.toThrow("10 GB");
		} finally {
			server?.stop(true);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
