import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { downloadUrlToPathParallel } from "../../lib/parallel-download";

const MB = 1024 * 1024;
const payload = new Uint8Array(4 * MB + 123).fill(47);
let directory: string;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-download-slots-"));
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

test.each([1, 2, 4])(
	"keeps all body streams within %i configured slots",
	async (concurrency) => {
		let active = 0;
		let maximum = 0;
		const fetchImpl = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const range = new Headers(init?.headers)
					.get("range")
					?.match(/^bytes=(\d+)-(\d+)$/);
				if (!range) throw new Error("Expected a range");
				const start = Number(range[1]);
				const end = Math.min(Number(range[2]), payload.length - 1);
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							active++;
							maximum = Math.max(maximum, active);
							await nextTurn();
							controller.enqueue(payload.subarray(start, end + 1));
							controller.close();
							active--;
						},
					}),
					{
						status: 206,
						headers: {
							"Content-Range": `bytes ${start}-${end}/${payload.length}`,
						},
					},
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const path = join(directory, `limit-${concurrency}.bin`);
		const result = await downloadUrlToPathParallel(
			"https://media.test/video",
			path,
			{ concurrency, partBytes: MB, fetchImpl },
		);
		expect(maximum).toBeLessThanOrEqual(concurrency);
		expect(active).toBe(0);
		expect(result).toEqual({ bytes: payload.length, parts: 5, ranged: true });
		expect(new Uint8Array(await readFile(path))).toEqual(payload);
	},
);

test("reuses the first body's slot while another body stays blocked", async () => {
	const secondStarted = Promise.withResolvers<void>();
	const thirdStarted = Promise.withResolvers<void>();
	const pending: Array<() => void> = [];
	let requests = 0;
	let autoRelease = false;
	const fetchImpl = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			const range = new Headers(init?.headers)
				.get("range")
				?.match(/^bytes=(\d+)-(\d+)$/);
			if (!range) throw new Error("Expected a range");
			const start = Number(range[1]);
			const end = Math.min(Number(range[2]), payload.length - 1);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const release = () => {
						controller.enqueue(payload.subarray(start, end + 1));
						controller.close();
					};
					if (autoRelease) release();
					else pending.push(release);
				},
			});
			requests++;
			if (requests === 2) secondStarted.resolve();
			if (requests === 3) thirdStarted.resolve();
			return new Response(body, {
				status: 206,
				headers: { "Content-Range": `bytes ${start}-${end}/${payload.length}` },
			});
		},
		{ preconnect: fetch.preconnect },
	);
	const path = join(directory, "refill.bin");
	const download = downloadUrlToPathParallel("https://media.test/video", path, {
		concurrency: 2,
		partBytes: MB,
		fetchImpl,
	});
	const timeout = setTimeout(
		() => thirdStarted.reject(new Error("First slot was never refilled")),
		2000,
	);
	try {
		await secondStarted.promise;
		pending.shift()?.();
		await thirdStarted.promise;
		expect(requests).toBe(3);
	} finally {
		clearTimeout(timeout);
		autoRelease = true;
		for (const release of pending) release();
		await download;
	}
	expect(new Uint8Array(await readFile(path))).toEqual(payload);
});
