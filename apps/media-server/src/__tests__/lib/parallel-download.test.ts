import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	downloadUrlToPathParallel,
	parallelDownloadOptionsFromEnv,
	planRanges,
} from "../../lib/parallel-download";

const MB = 1024 * 1024;
const payload = randomBytes(5 * MB + 12345);
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let rangeRequests = 0;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "parallel-download-"));
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
			if (url.pathname === "/plain" || !range) {
				return new Response(payload, { headers: { ETag: '"v1"' } });
			}
			rangeRequests++;
			if (url.pathname === "/changed" && Number(range[1]) > 0) {
				return new Response("precondition", { status: 412 });
			}
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), payload.length - 1);
			const body =
				url.pathname === "/short" && start > 0
					? payload.subarray(start, end)
					: payload.subarray(start, end + 1);
			return new Response(body, {
				status: 206,
				headers: {
					ETag: '"v1"',
					"Content-Range": `bytes ${start}-${end}/${payload.length}`,
				},
			});
		},
	});
});

afterAll(async () => {
	server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

describe("parallel download", () => {
	test("env defaults keep the single-stream path", () => {
		expect(parallelDownloadOptionsFromEnv({})).toEqual({
			concurrency: 1,
			partBytes: 16 * MB,
		});
		expect(
			parallelDownloadOptionsFromEnv({
				MEDIA_SERVER_DOWNLOAD_CONCURRENCY: "8",
				MEDIA_SERVER_DOWNLOAD_PART_MB: "32",
			}),
		).toEqual({ concurrency: 8, partBytes: 32 * MB });
		expect(
			parallelDownloadOptionsFromEnv({
				MEDIA_SERVER_DOWNLOAD_CONCURRENCY: "500",
			}).concurrency,
		).toBe(32);
	});

	test("plans contiguous ranges after the first part", () => {
		expect(planRanges(10, 4, 3)).toEqual([
			{ start: 4, end: 6 },
			{ start: 7, end: 9 },
		]);
		expect(planRanges(4, 4, 3)).toEqual([]);
	});

	test("reassembles ranged parts byte for byte", async () => {
		const path = join(dir, "ranged.bin");
		const result = await downloadUrlToPathParallel(
			`http://localhost:${server.port}/file`,
			path,
			{ concurrency: 4, partBytes: MB },
		);
		expect(result.ranged).toBe(true);
		expect(result.parts).toBe(6);
		expect(Buffer.compare(await readFile(path), payload)).toBe(0);
	});

	test("falls back to one stream when ranges are unsupported", async () => {
		const path = join(dir, "plain.bin");
		const result = await downloadUrlToPathParallel(
			`http://localhost:${server.port}/plain`,
			path,
			{ concurrency: 4, partBytes: MB },
		);
		expect(result).toEqual({ bytes: payload.length, parts: 1, ranged: false });
		expect(Buffer.compare(await readFile(path), payload)).toBe(0);
	});

	test("fails when the object changes mid-download", async () => {
		await expect(
			downloadUrlToPathParallel(
				`http://localhost:${server.port}/changed`,
				join(dir, "changed.bin"),
				{ concurrency: 4, partBytes: MB },
			),
		).rejects.toThrow("Ranged download part failed: 412");
	});

	test("fails when a part comes back short", async () => {
		await expect(
			downloadUrlToPathParallel(
				`http://localhost:${server.port}/short`,
				join(dir, "short.bin"),
				{ concurrency: 4, partBytes: MB },
			),
		).rejects.toThrow("expected");
	});

	test("stops on abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const before = rangeRequests;
		await expect(
			downloadUrlToPathParallel(
				`http://localhost:${server.port}/file`,
				join(dir, "aborted.bin"),
				{ concurrency: 4, partBytes: MB, signal: controller.signal },
			),
		).rejects.toThrow();
		expect(rangeRequests).toBe(before);
	});
});
