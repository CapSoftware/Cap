import { afterEach, expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadDriveResumable } from "../../lib/drive-resumable-upload";

const originalFetch = globalThis.fetch;
const chunk = 32 * 1024 ** 2;
const dirs: string[] = [];
afterEach(async () => {
	globalThis.fetch = originalFetch;
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function sparseFile(size: number) {
	const dir = await mkdtemp(join(tmpdir(), "cap-drive-upload-"));
	dirs.push(dir);
	const path = join(dir, "output.mp4");
	const handle = await open(path, "w");
	try {
		await handle.truncate(size);
		await handle.write(new Uint8Array([99]), 0, 1, size - 1);
	} finally {
		await handle.close();
	}
	return Bun.file(path);
}

function incomplete(end?: number) {
	return new Response(null, {
		status: 308,
		headers: end === undefined ? {} : { Range: `bytes=0-${end - 1}` },
	});
}

test("slices real files beyond 8 GiB without truncating offsets or allocating the file", async () => {
	const size = 9 * 1024 ** 3 + 123;
	const body = await sparseFile(size);
	let received = 0;
	globalThis.fetch = (async (_url, init) => {
		const piece = init?.body as Blob;
		const end = Math.min(received + chunk, size);
		expect(piece.size).toBe(end - received);
		expect(new Headers(init?.headers).get("Content-Range")).toBe(
			`bytes ${received}-${end - 1}/${size}`,
		);
		if (end === size)
			expect(new Uint8Array(await piece.slice(-1).arrayBuffer())[0]).toBe(99);
		received = end;
		return received === size
			? Response.json({ size: String(size) })
			: incomplete(received);
	}) as typeof fetch;
	const result = await uploadDriveResumable(
		"https://drive.test/upload",
		body,
		"video/mp4",
	);
	expect(received).toBe(size);
	expect(await result.json()).toEqual({ size: String(size) });
});

test.each(["disconnect", "503"])(
	"resumes confirmed partial bytes after %s without replaying the prefix",
	async (mode) => {
		const body = await sparseFile(chunk + 123);
		const requests: string[] = [];
		globalThis.fetch = (async (_url, init) => {
			requests.push(new Headers(init?.headers).get("Content-Range") ?? "");
			if (requests.length === 1) {
				if (mode === "disconnect") throw new Error("Connection lost");
				return new Response(null, { status: 503 });
			}
			if (requests.length === 2) return incomplete(chunk / 2);
			expect((init?.body as Blob).size).toBe(chunk / 2 + 123);
			return Response.json({ done: true });
		}) as typeof fetch;
		await uploadDriveResumable("https://drive.test/upload", body, "video/mp4");
		expect(requests).toEqual([
			`bytes 0-${chunk - 1}/${body.size}`,
			`bytes */${body.size}`,
			`bytes ${chunk / 2}-${body.size - 1}/${body.size}`,
		]);
	},
);

test("reconciles a lost final response without sending the output again", async () => {
	const requests: string[] = [];
	globalThis.fetch = (async (_url, init) => {
		requests.push(new Headers(init?.headers).get("Content-Range") ?? "");
		if (requests.length === 1) throw new Error("Final response lost");
		return Response.json({ done: true });
	}) as typeof fetch;
	await uploadDriveResumable(
		"https://drive.test/upload",
		new Blob(["abc"]),
		"video/mp4",
	);
	expect(requests).toEqual(["bytes 0-2/3", "bytes */3"]);
});

test.each(["bytes=0-999", "bytes=1-2", "nonsense", "bytes=0-9007199254740993"])(
	"rejects untrustworthy offsets %s",
	async (range) => {
		globalThis.fetch = (async () =>
			new Response(null, {
				status: 308,
				headers: { Range: range },
			})) as typeof fetch;
		await expect(
			uploadDriveResumable(
				"https://drive.test/upload",
				new Blob(["abc"]),
				"video/mp4",
			),
		).rejects.toThrow("invalid upload offset");
	},
);

test("bounds an upload that never acknowledges progress", async () => {
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		return incomplete();
	}) as typeof fetch;
	await expect(
		uploadDriveResumable(
			"https://drive.test/upload",
			new Blob(["abc"]),
			"video/mp4",
		),
	).rejects.toThrow("no progress");
	expect(requests).toBe(9);
}, 10000);

test("cancels backoff without resending media", async () => {
	const controller = new AbortController();
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		controller.abort();
		throw new Error("lost");
	}) as typeof fetch;
	await expect(
		uploadDriveResumable(
			"https://drive.test/upload",
			new Blob(["abc"]),
			"video/mp4",
			undefined,
			controller.signal,
		),
	).rejects.toThrow();
	expect(requests).toBe(1);
});

test.skipIf(process.env.MEDIA_SERVER_TRANSFER_PERFORMANCE_TESTS !== "1")(
	"streams a 9 GiB output over HTTP within bounded memory",
	async () => {
		const size = 9 * 1024 ** 3 + 123;
		const body = await sparseFile(size);
		let received = 0;
		let lastByte = 0;
		let requests = 0;
		const baseline = process.memoryUsage().rss;
		let peak = baseline;
		const started = performance.now();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				requests++;
				const start = received;
				const reader = request.body?.getReader();
				if (!reader) {
					console.log(
						JSON.stringify({
							event: "drive_status_probe",
							received,
							range: request.headers.get("Content-Range"),
						}),
					);
					return incomplete(received || undefined);
				}
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					received += next.value.length;
					lastByte = next.value[next.value.length - 1];
				}
				peak = Math.max(peak, process.memoryUsage().rss);
				expect(request.headers.get("Content-Range")).toBe(
					`bytes ${start}-${received - 1}/${size}`,
				);
				return received === size
					? Response.json({ done: true })
					: incomplete(received);
			},
		});
		try {
			await uploadDriveResumable(
				`http://127.0.0.1:${server.port}/upload`,
				body,
				"video/mp4",
			);
			expect(received).toBe(size);
			expect(lastByte).toBe(99);
			expect(requests).toBe(Math.ceil(size / chunk));
			expect(peak - baseline).toBeLessThan(384 * 1024 ** 2);
			console.log(
				JSON.stringify({
					event: "drive_large_upload_verified",
					bytes: received,
					requests,
					elapsedMs: Math.round(performance.now() - started),
					peakRssGrowthMiB: Math.round((peak - baseline) / 1024 ** 2),
				}),
			);
		} finally {
			await server.stop(true);
		}
	},
	120000,
);
