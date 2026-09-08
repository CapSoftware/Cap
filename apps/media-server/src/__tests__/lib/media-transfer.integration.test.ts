import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadDriveRevision } from "../../lib/media-transfer";

test.skipIf(process.env.MEDIA_SERVER_TRANSFER_PERFORMANCE_TESTS !== "1")(
	"streams and verifies a transfer larger than two GiB with bounded memory",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "cap-large-transfer-"));
		const path = join(directory, "input.bin");
		const chunk = Buffer.alloc(1024 ** 2, 0x5a);
		const size = 2 * 1024 ** 3 + chunk.length;
		const expected = createHash("sha256");
		for (let offset = 0; offset < size; offset += chunk.length)
			expected.update(chunk);
		const sha256 = expected.digest("hex");
		let requests = 0;
		let transferred = 0;
		let peakRss = process.memoryUsage().rss;
		const timer = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 25);
		const started = performance.now();
		try {
			const fetcher = Object.assign(
				async () => {
					requests++;
					let sent = 0;
					return new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								if (sent === size) controller.close();
								else {
									controller.enqueue(chunk);
									sent += chunk.length;
								}
							},
						}),
						{ headers: { "Content-Length": String(size) } },
					);
				},
				{ preconnect: fetch.preconnect },
			);
			await downloadDriveRevision(
				{
					version: 1,
					url: "https://www.googleapis.com/drive/v3/files/test/revisions/test?alt=media",
					authorization: "Bearer synthetic-test",
					objectIdentity: '"synthetic-large-revision"',
					size,
					sha256,
				},
				path,
				{
					fetcher,
					onBytes: (bytes) => {
						transferred += bytes;
					},
				},
			);
			const actual = createHash("sha256");
			for await (const bytes of Bun.file(path).stream()) actual.update(bytes);
			expect(actual.digest("hex")).toBe(sha256);
			expect((await stat(path)).size).toBe(size);
			expect(transferred).toBe(size);
			expect(requests).toBe(1);
			expect(peakRss).toBeLessThan(512 * 1024 ** 2);
			console.info("[large-transfer-verification]", {
				bytes: size,
				elapsedMs: Math.round(performance.now() - started),
				peakRssMB: Math.round(peakRss / 1024 ** 2),
			});
		} finally {
			clearInterval(timer);
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000,
);
