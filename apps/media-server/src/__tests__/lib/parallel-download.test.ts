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
			if (url.pathname === "/no-total" || url.pathname === "/capped") {
				const end =
					url.pathname === "/capped" ? 64 * 1024 - 1 : Number(range[2]);
				return new Response(payload.subarray(0, end + 1), {
					status: 206,
					headers: {
						"Content-Range":
							url.pathname === "/capped"
								? `bytes 0-${end}/${payload.length}`
								: `bytes 0-${end}/*`,
					},
				});
			}
			if (url.pathname === "/huge") {
				return new Response(payload.subarray(0, MB), {
					status: 206,
					headers: {
						"Content-Range": `bytes 0-${MB - 1}/${Number.MAX_SAFE_INTEGER}`,
					},
				});
			}
			if (url.pathname === "/changed" && Number(range[1]) > 0) {
				return new Response("precondition", { status: 412 });
			}
			if (url.pathname.startsWith("/mismatched-") && Number(range[1]) > 0) {
				const start = Number(range[1]);
				const end = Math.min(Number(range[2]), payload.length - 1);
				const kind = url.pathname.slice("/mismatched-".length);
				const contentRange =
					kind === "missing"
						? undefined
						: kind === "unknown-total"
							? `bytes ${start}-${end}/*`
							: kind === "start"
								? `bytes 0-${end - start}/${payload.length}`
								: kind === "end"
									? `bytes ${start}-${end + 1}/${payload.length}`
									: `bytes ${start}-${end}/${payload.length + 1}`;
				return new Response(payload.subarray(0, end - start + 1), {
					status: 206,
					headers: {
						ETag: '"v1"',
						...(contentRange ? { "Content-Range": contentRange } : {}),
					},
				});
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
		const ranges = planRanges(10, 4, 3);
		expect(ranges.count).toBe(2);
		expect([ranges.at(0), ranges.at(1)]).toEqual([
			{ start: 4, end: 6 },
			{ start: 7, end: 9 },
		]);
		expect(planRanges(4, 4, 3).count).toBe(0);
		expect(planRanges(Number.MAX_SAFE_INTEGER, MB, MB).count).toBeGreaterThan(
			1e9,
		);
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

	test.each(["no-total", "capped"])(
		"restarts as one stream when the first range can't be used (%s)",
		async (name) => {
			const path = join(dir, `${name}.bin`);
			const result = await downloadUrlToPathParallel(
				`http://localhost:${server.port}/${name}`,
				path,
				{ concurrency: 4, partBytes: MB },
			);
			expect(result).toEqual({
				bytes: payload.length,
				parts: 1,
				ranged: false,
			});
			expect(Buffer.compare(await readFile(path), payload)).toBe(0);
		},
	);

	test("rejects an absurd Content-Range total before planning parts", async () => {
		const before = rangeRequests;
		await expect(
			downloadUrlToPathParallel(
				`http://localhost:${server.port}/huge`,
				join(dir, "huge.bin"),
				{ concurrency: 4, partBytes: MB },
			),
		).rejects.toThrow("invalid size");
		expect(rangeRequests).toBe(before + 1);
	});

	test.each(["start", "end", "total", "missing", "unknown-total"])(
		"rejects a same-sized response with mismatched range metadata (%s)",
		async (kind) => {
			await expect(
				downloadUrlToPathParallel(
					`http://localhost:${server.port}/mismatched-${kind}`,
					join(dir, `mismatched-${kind}.bin`),
					{ concurrency: 4, partBytes: MB },
				),
			).rejects.toThrow("Content-Range");
		},
	);

	test("does not write beyond a declared range before rejecting an oversized body", async () => {
		const path = join(dir, "oversized.bin");
		const fetchImpl = Object.assign(
			async () =>
				new Response(new Uint8Array(MB + 1), {
					status: 206,
					headers: { "Content-Range": `bytes 0-${MB - 1}/${MB}` },
				}),
			{ preconnect: fetch.preconnect },
		);
		await expect(
			downloadUrlToPathParallel("https://media.test/file", path, {
				concurrency: 2,
				partBytes: MB,
				fetchImpl,
			}),
		).rejects.toThrow("expected");
		expect((await readFile(path)).length).toBeLessThanOrEqual(MB);
	});

	test("cancels an unread response whose range cannot be placed", async () => {
		let cancelled = false;
		let requests = 0;
		const fetchImpl = Object.assign(
			async () => {
				requests++;
				if (requests === 1) {
					return new Response(new Uint8Array(MB), {
						status: 206,
						headers: { "Content-Range": `bytes 0-${MB - 1}/${2 * MB}` },
					});
				}
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{
						status: 206,
						headers: { "Content-Range": `bytes 0-${MB - 1}/${2 * MB}` },
					},
				);
			},
			{ preconnect: fetch.preconnect },
		);
		await expect(
			downloadUrlToPathParallel(
				"https://media.test/file",
				join(dir, "cancelled-range.bin"),
				{
					concurrency: 2,
					partBytes: MB,
					fetchImpl,
				},
			),
		).rejects.toThrow("Content-Range");
		expect(cancelled).toBe(true);
		expect(requests).toBe(2);
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
