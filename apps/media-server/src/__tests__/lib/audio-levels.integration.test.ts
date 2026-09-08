import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enhanceLocalRecording } from "../../lib/audio-levels";
import * as jobManager from "../../lib/job-manager";
import * as operations from "../../lib/media-operations";
import { probeVideoFile } from "../../lib/media-probe";
import { withMediaTransfers } from "../../lib/media-transfer";
import { processVideo } from "../../lib/media-video";
import {
	getActiveDirectVideoProcessCount,
	tryAcquireDirectVideoProcessSlot,
} from "../../lib/video-capacity";

let directory: string;
let source: Uint8Array;
const originalFetch = globalThis.fetch;
const originalSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
let capacity: ReturnType<typeof spyOn>;
let audioCapacity: ReturnType<typeof spyOn>;
const request = {
	videoId: "video",
	userId: "owner",
	jobId: "job",
	sourceKey: "owner/video/result.mp4",
	webhookUrl: "https://web.test/progress",
	webhookSecret: "secret",
	duration: 4,
	sourceIdentity: '"source"',
	outputUrl: "https://storage.test/output.mp4",
	verificationUrl: "https://storage.test/output.mp4",
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-audio-route-"));
	const path = join(directory, "source.mp4");
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x90:rate=15:duration=4",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=0.02*sin(2*PI*440*t):s=48000:d=4",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-c:a",
			"aac",
			"-threads",
			"1",
			path,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	const [code, error] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(error);
	source = await readFile(path);
});
beforeEach(() => {
	capacity = spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(
		true,
	);
	audioCapacity = spyOn(
		operations,
		"canAcceptNewAudioOperation",
	).mockReturnValue(true);
});
afterEach(() => {
	capacity.mockRestore();
	audioCapacity.mockRestore();
	globalThis.fetch = originalFetch;
	if (originalSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = originalSecret;
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

function call(
	overrides: Partial<Parameters<typeof enhanceLocalRecording>[0]> = {},
) {
	return enhanceLocalRecording({
		...request,
		path: join(directory, "source.mp4"),
		...overrides,
	});
}
function storage(
	options: {
		corruptUpload?: boolean;
		prepare?: (signal?: AbortSignal | null) => Promise<void>;
		unavailable?: boolean;
		rejectPublication?: boolean;
	} = {},
) {
	let output: ArrayBuffer | undefined;
	let uploads = 0;
	let publications = 0;
	let preparations = 0;
	let downloadedBytes = 0;
	let fullDownloads = 0;
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === request.webhookUrl) {
				expect(init?.method).toBe("POST");
				expect(new Headers(init?.headers).get("x-media-server-secret")).toBe(
					request.webhookSecret,
				);
				const body = JSON.parse(String(init?.body));
				if (body.action === "prepare") {
					preparations++;
					await options.prepare?.(init?.signal);
					return Response.json(
						options.unavailable
							? { status: "unchanged" }
							: {
									status: "prepared",
									outputUrl: request.outputUrl,
									verificationUrl: request.verificationUrl,
									token: "token",
									transferBudgetBytes: 16 * 1024 * 1024,
								},
					);
				}
				publications++;
				expect(output).toBeDefined();
				expect(body.action).toBe("publish");
				return Response.json({
					status: options.rejectPublication ? "unchanged" : "published",
				});
			}
			expect(url).toBe(request.outputUrl);
			if (init?.method === "PUT") {
				expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
				output = await new Response(init.body).arrayBuffer();
				uploads++;
				return new Response(null, { headers: { ETag: '"output"' } });
			}
			if (!output) throw new Error("Output not uploaded");
			if (new Headers(init?.headers).get("range") === "bytes=0-0") {
				downloadedBytes++;
				return new Response(output.slice(0, 1), {
					status: 206,
					headers: {
						ETag: '"output"',
						"Content-Length": "1",
						"Content-Range": `bytes 0-0/${output.byteLength}`,
					},
				});
			}
			const bytes = output.slice(0);
			downloadedBytes += bytes.byteLength;
			fullDownloads++;
			if (options.corruptUpload) new Uint8Array(bytes)[0] ^= 1;
			return new Response(init?.method === "HEAD" ? null : bytes, {
				headers: {
					ETag: '"output"',
					"Content-Length": String(bytes.byteLength),
					"Content-Type": "video/mp4",
				},
			});
		},
		{ preconnect: originalFetch.preconnect },
	);
	return {
		uploads: () => uploads,
		publications: () => publications,
		preparations: () => preparations,
		downloadedBytes: () => downloadedBytes,
		fullDownloads: () => fullDownloads,
	};
}
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

describe("local audio levels integration", () => {
	test("publishes from the local file without a source download or source mutation", async () => {
		const objects = storage();
		const result = await call();
		expect(result.status).toBe("published");
		if (result.status !== "published") throw new Error(result.reason);
		expect(result.outputLufs).toBeGreaterThan(result.inputLufs + 1);
		expect(result.truePeak).toBeLessThanOrEqual(-1);
		expect(objects.uploads()).toBe(1);
		expect(objects.publications()).toBe(1);
		expect(objects.fullDownloads()).toBe(1);
		expect(objects.downloadedBytes()).toBe(result.outputSize + 2);
		expect(hash(await readFile(join(directory, "source.mp4")))).toBe(
			hash(source),
		);
	});
	test("uses its reserved verification budget independently of the completed recording job", async () => {
		storage();
		expect((await withMediaTransfers(1, () => call())).status).toBe(
			"published",
		);
	});
	test("retains the original without network access when video capacity is exhausted", async () => {
		capacity.mockReturnValue(false);
		const objects = storage();
		expect(await call()).toEqual({ status: "unchanged", reason: "capacity" });
		expect(objects.preparations()).toBe(0);
	});
	test("retains the original without network access when audio capacity is exhausted", async () => {
		audioCapacity.mockReturnValue(false);
		const objects = storage();
		expect(await call()).toEqual({ status: "unchanged", reason: "capacity" });
		expect(objects.preparations()).toBe(0);
	});
	test("does not publish corrupted stored bytes", async () => {
		const objects = storage({ corruptUpload: true });
		expect((await call()).status).toBe("unchanged");
		expect(objects.publications()).toBe(0);
	});
	test("leaves an occupied conversion slot available to its current owner", async () => {
		const slot = tryAcquireDirectVideoProcessSlot(() => true);
		expect(slot).not.toBeNull();
		try {
			const objects = storage();
			expect(await call()).toEqual({ status: "unchanged", reason: "capacity" });
			expect(objects.preparations()).toBe(0);
			expect(getActiveDirectVideoProcessCount()).toBe(1);
		} finally {
			slot?.release();
		}
	});
	test("cancels optional work on shutdown and releases its processing slot", async () => {
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		storage({
			prepare: (signal) =>
				new Promise((_, reject) => {
					signal?.addEventListener(
						"abort",
						() => reject(new Error("Cancelled")),
						{ once: true },
					);
					entered();
				}),
		});
		const pending = call();
		await started;
		await operations.cancelAllMediaOperations();
		expect((await pending).status).toBe("unchanged");
		expect(getActiveDirectVideoProcessCount()).toBe(0);
		expect(operations.getActiveAudioOperationCount()).toBe(0);
		expect(hash(await readFile(join(directory, "source.mp4")))).toBe(
			hash(source),
		);
	});
	test("does not render or upload when publication is unavailable", async () => {
		const objects = storage({ unavailable: true });
		expect((await call()).status).toBe("unchanged");
		expect(objects.uploads()).toBe(0);
	});
	test("retains the source if publication is rejected", async () => {
		storage({ rejectPublication: true });
		expect((await call()).status).toBe("unchanged");
		expect(hash(await readFile(join(directory, "source.mp4")))).toBe(
			hash(source),
		);
	});
	test.each([900.001, 0, -1, NaN, Infinity])(
		"skips unsupported duration %s without network access",
		async (duration) => {
			const objects = storage();
			expect((await call({ duration })).status).toBe("unchanged");
			expect(objects.preparations()).toBe(0);
		},
	);
	test("limits local correction concurrency", async () => {
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		storage({
			prepare: async () => {
				entered();
				await pending;
			},
		});
		const first = call();
		await started;
		try {
			expect(getActiveDirectVideoProcessCount()).toBe(1);
			expect(await call()).toEqual({ status: "unchanged", reason: "capacity" });
		} finally {
			release();
		}
		expect((await first).status).toBe("published");
		expect(getActiveDirectVideoProcessCount()).toBe(0);
	});
	test("corrects the MP4 from the existing Chrome WebM conversion without downloading it", async () => {
		const rawPath = join(directory, "chrome.webm");
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-i",
				join(directory, "source.mp4"),
				"-c:v",
				"libvpx-vp9",
				"-deadline",
				"realtime",
				"-cpu-used",
				"8",
				"-c:a",
				"libopus",
				"-threads",
				"1",
				rawPath,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const [code, error] = await Promise.all([
			proc.exited,
			new Response(proc.stderr).text(),
		]);
		if (code !== 0) throw new Error(error);
		const rawHash = hash(await readFile(rawPath));
		const metadata = await probeVideoFile(rawPath);
		const mp4 = await processVideo(rawPath, metadata);
		try {
			const before = hash(await readFile(mp4.path));
			storage();
			const result = await call({ path: mp4.path });
			expect(result.status).toBe("published");
			expect(hash(await readFile(mp4.path))).toBe(before);
			expect(hash(await readFile(rawPath))).toBe(rawHash);
		} finally {
			await mp4.cleanup();
		}
	}, 30_000);
});
