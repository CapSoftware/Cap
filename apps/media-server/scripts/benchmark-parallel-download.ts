import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const concurrency = Number(process.argv[2] ?? 2);
const mode = process.argv[3] ?? "large";
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
	throw new Error("Concurrency must be between 1 and 64");
if (!["large", "small", "plain"].includes(mode))
	throw new Error("Mode must be large, small or plain");

import { downloadUrlToPathParallel } from "../src/lib/parallel-download";

const responseDelayMs = 30;
const partBytes = 8 * 1024 * 1024;
const bytes = mode === "small" ? 1024 * 1024 : 128 * 1024 * 1024 + 123;
const payload = new Uint8Array(bytes);
for (let i = 0; i < bytes; i++) payload[i] = (i * 31 + (i >>> 20)) & 255;
const fingerprint = createHash("sha256").update(payload).digest("hex");
const directory = await mkdtemp(join(tmpdir(), "cap-download-slot-bench-"));
let requests = 0;
let active = 0;
let peak = 0;
const sockets = new Set<number>();
const server = Bun.serve({
	port: 0,
	fetch(request, server) {
		const port = server.requestIP(request)?.port;
		if (port !== undefined) sockets.add(port);
		requests++;
		const match = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
		const start = mode === "plain" ? 0 : Number(match?.[1] ?? 0);
		const end =
			mode === "plain"
				? bytes - 1
				: Math.min(Number(match?.[2] ?? bytes - 1), bytes - 1);
		active++;
		peak = Math.max(peak, active);
		let settled = false;
		const finish = () => {
			if (!settled) {
				settled = true;
				active--;
			}
		};
		return new Response(
			new ReadableStream({
				async start(controller) {
					await Bun.sleep(responseDelayMs);
					if (settled) return;
					controller.enqueue(payload.subarray(start, end + 1));
					controller.close();
					finish();
				},
				cancel() {
					finish();
				},
			}),
			{
				status: mode === "plain" ? 200 : 206,
				headers: {
					ETag: '"fixture"',
					...(mode === "plain"
						? {}
						: { "Content-Range": `bytes ${start}-${end}/${bytes}` }),
				},
			},
		);
	},
});
try {
	const path = join(directory, "download.bin");
	const begin = performance.now();
	const result = await downloadUrlToPathParallel(
		`http://127.0.0.1:${server.port}/recording`,
		path,
		{ concurrency, partBytes },
	);
	const elapsedMs = performance.now() - begin;
	const actual = createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
	if (actual !== fingerprint || result.bytes !== bytes)
		throw new Error("byte mismatch");
	console.log(
		JSON.stringify({
			source: import.meta.resolve("../src/lib/parallel-download.ts"),
			responseDelayMs,
			concurrency,
			mode,
			bytes,
			elapsedMs,
			result,
			requests,
			peakDelayedResponses: peak,
			tcpConnections: sockets.size,
			fingerprint,
		}),
	);
} finally {
	await server.stop(true);
	await rm(directory, { recursive: true, force: true });
}
