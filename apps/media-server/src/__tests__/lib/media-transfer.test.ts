import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupMediaTransferCache,
	downloadDriveRevision,
	getMediaDownloadTarget,
	type MediaDownloadTarget,
	MediaTransferBudgetError,
	materializeMedia,
	releaseMaterializedMedia,
	withMediaTransfers,
} from "../../lib/media-transfer";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = originalSecret;
	await cleanupMediaTransferCache();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function destination() {
	const root = await mkdtemp(join(tmpdir(), "media-transfer-test-"));
	roots.push(root);
	return join(root, "recording.mp4");
}
const content = Buffer.from("a real transfer with an interrupted stream");
function target(): MediaDownloadTarget {
	return {
		version: 1,
		url: "https://www.googleapis.com/drive/v3/files/file/revisions/revision?alt=media",
		authorization: "Bearer private",
		objectIdentity: '"identity"',
		size: content.length,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}
function fetcher(
	run: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Response | Promise<Response>,
): typeof fetch {
	return Object.assign(run, { preconnect: fetch.preconnect }) as typeof fetch;
}
describe("bounded revision downloads", () => {
	test("pins the descriptor with an application header and rejects changed identity", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "worker-secret";
		globalThis.fetch = fetcher((_input, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("if-match")).toBeNull();
			expect(headers.get("x-cap-recording-object-identity")).toBe('"identity"');
			return Response.json(target());
		});
		expect(
			await getMediaDownloadTarget(
				"https://cap.so/api/storage/object",
				undefined,
				'"identity"',
			),
		).toEqual(target());
		globalThis.fetch = fetcher(() =>
			Response.json({ ...target(), objectIdentity: '"changed"' }),
		);
		await expect(
			getMediaDownloadTarget(
				"https://cap.so/api/storage/object",
				undefined,
				'"identity"',
			),
		).rejects.toThrow("Recording object changed");
	});

	test("resumes an interrupted pinned revision without rereading completed bytes", async () => {
		const path = await destination();
		let calls = 0;
		let received = 0;
		const network = fetcher((_input, init) => {
			calls++;
			if (calls === 1) {
				let pull = 0;
				return new Response(
					new ReadableStream({
						pull(controller) {
							if (pull++ === 0) controller.enqueue(content.subarray(0, 12));
							else controller.error(new Error("network disconnected"));
						},
					}),
					{ headers: { "Content-Length": String(content.length) } },
				);
			}
			expect(new Headers(init?.headers).get("range")).toBe("bytes=12-");
			return new Response(content.subarray(12), {
				status: 206,
				headers: {
					"Content-Length": String(content.length - 12),
					"Content-Range": `bytes 12-${content.length - 1}/${content.length}`,
				},
			});
		});
		await downloadDriveRevision(target(), path, {
			fetcher: network,
			onBytes: (bytes) => {
				received += bytes;
			},
		});
		expect(await readFile(path)).toEqual(content);
		expect(received).toBe(content.length);
		expect(calls).toBe(2);
	});
	test("rejects corruption and removes the incomplete file", async () => {
		const path = await destination();
		await expect(
			downloadDriveRevision(target(), path, {
				fetcher: fetcher(
					() =>
						new Response(Buffer.alloc(content.length), {
							headers: { "Content-Length": String(content.length) },
						}),
				),
			}),
		).rejects.toThrow("checksum");
		expect(await stat(path).catch(() => null)).toBeNull();
	});
	test("does not retry after the byte budget is exhausted", async () => {
		let calls = 0;
		await expect(
			downloadDriveRevision(target(), await destination(), {
				fetcher: fetcher(() => {
					calls++;
					return new Response(content, {
						headers: { "Content-Length": String(content.length) },
					});
				}),
				onBytes: () => {
					throw new MediaTransferBudgetError();
				},
			}),
		).rejects.toBeInstanceOf(MediaTransferBudgetError);
		expect(calls).toBe(1);
	});
	test("does not forward worker credentials to an arbitrary host", async () => {
		await expect(
			getMediaDownloadTarget("https://attacker.example/api/storage/object"),
		).rejects.toThrow("Untrusted");
	});
	test("bounds a repeatedly truncated source to three requests", async () => {
		let calls = 0;
		await expect(
			downloadDriveRevision(target(), await destination(), {
				fetcher: fetcher(() => {
					calls++;
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.close();
							},
						}),
						{ headers: { "Content-Length": String(content.length) } },
					);
				}),
			}),
		).rejects.toThrow("checksum or size");
		expect(calls).toBe(3);
	});
});

describe("parallel transfer admission and cache reuse", () => {
	function network() {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "worker-secret";
		let downloads = 0;
		globalThis.fetch = fetcher((input) => {
			if (String(input).startsWith("https://cap.so/"))
				return Response.json(target());
			downloads++;
			return new Response(content, {
				headers: { "Content-Length": String(content.length) },
			});
		});
		return () => downloads;
	}
	const url = () => `https://cap.so/api/storage/object?key=${randomUUID()}`;

	test("reuses a verified file across retries without another media download", async () => {
		const downloads = network();
		const input = url();
		await withMediaTransfers(content.length, async () => {
			const first = await materializeMedia(input);
			const second = await materializeMedia(input);
			expect(first?.path).toBe(second?.path);
		});
		await withMediaTransfers(1, async () => {
			expect(await materializeMedia(input)).toBeDefined();
		});
		expect(downloads()).toBe(1);
	});

	test("downloads one revision once across six concurrent job contexts", async () => {
		const downloads = network();
		const input = url();
		const paths = await Promise.all(
			Array.from({ length: 6 }, () =>
				withMediaTransfers(content.length, async () => {
					const local = await materializeMedia(input);
					if (!local) throw new Error("Missing materialized input");
					expect(await readFile(local.path)).toEqual(content);
					return local.path;
				}),
			),
		);
		expect(new Set(paths).size).toBe(1);
		expect(downloads()).toBe(1);
	});

	test("canceling a waiting job does not cancel the shared owner's download", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "worker-secret";
		let downloads = 0;
		let release = () => {};
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		globalThis.fetch = fetcher(async (input) => {
			if (String(input).startsWith("https://cap.so/"))
				return Response.json(target());
			downloads++;
			entered();
			await gate;
			return new Response(content, {
				headers: { "Content-Length": String(content.length) },
			});
		});
		const input = url();
		const owner = withMediaTransfers(content.length, () =>
			materializeMedia(input),
		);
		await started;
		const controller = new AbortController();
		const waiting = withMediaTransfers(content.length, () =>
			materializeMedia(input, controller.signal),
		);
		controller.abort(new Error("Waiting job canceled"));
		await expect(waiting).rejects.toThrow("Waiting job canceled");
		release();
		expect(await owner).toBeDefined();
		expect(downloads).toBe(1);
	});

	test("releases one cache retention after concurrent reads in the same job", async () => {
		const downloads = network();
		const input = url();
		await withMediaTransfers(content.length, () => materializeMedia(input));
		await withMediaTransfers(content.length, async () => {
			const reads = await Promise.all(
				Array.from({ length: 10 }, () => materializeMedia(input)),
			);
			expect(new Set(reads.map((read) => read?.path)).size).toBe(1);
		});
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
		try {
			await withMediaTransfers(content.length, () => materializeMedia(input));
		} finally {
			clock.mockRestore();
		}
		expect(downloads()).toBe(2);
	});

	test("keeps a shared pathname until both same-job consumers release it", async () => {
		network();
		const input = url();
		await withMediaTransfers(content.length * 2, async () => {
			const [first, second] = await Promise.all([
				materializeMedia(input),
				materializeMedia(input),
			]);
			if (!first || !second) throw new Error("Missing shared input");
			await releaseMaterializedMedia(first.path);
			const now = Date.now();
			const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
			try {
				await materializeMedia(url());
				expect(await readFile(second.path)).toEqual(content);
				await releaseMaterializedMedia(second.path);
			} finally {
				clock.mockRestore();
			}
		});
	});

	test("retains a worker input after its cache pathname is removed", async () => {
		network();
		await withMediaTransfers(content.length, async () => {
			const local = await materializeMedia(url());
			expect(local).toBeDefined();
			if (!local) throw new Error("Input was not materialized");
			const path = await destination();
			await link(local.path, path);
			await releaseMaterializedMedia(local.path);
			await cleanupMediaTransferCache();
			expect(await readFile(path)).toEqual(content);
		});
	});

	test("does not let simultaneous files overbook the remaining byte budget", async () => {
		const downloads = network();
		await withMediaTransfers(content.length, async () => {
			const results = await Promise.allSettled([
				materializeMedia(url()),
				materializeMedia(url()),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			const failed = results.find((result) => result.status === "rejected");
			expect(
				failed?.status === "rejected" &&
					failed.reason instanceof MediaTransferBudgetError,
			).toBe(true);
		});
		expect(downloads()).toBe(1);
	});

	test("does not follow a descriptor redirect with worker credentials", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "worker-secret";
		let calls = 0;
		globalThis.fetch = fetcher((_input, init) => {
			calls++;
			expect(init?.redirect).toBe("manual");
			return Response.redirect("https://attacker.example/", 307);
		});
		await expect(getMediaDownloadTarget(url())).rejects.toThrow(
			"authorization failed",
		);
		expect(calls).toBe(1);
	});
});
