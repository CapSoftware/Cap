import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createHook: vi.fn(),
	hookDispose: vi.fn(),
	rows: [] as unknown[][],
	where: vi.fn(),
	write: vi.fn(),
	getAccess: vi.fn(),
	get: vi.fn(),
	put: vi.fn(),
	head: vi.fn(),
	remove: vi.fn(),
	fetch: vi.fn(),
	statusFetch: vi.fn(),
	dispatch: vi.fn(),
	mediaJobFailed: vi.fn(),
	sleep: vi.fn(),
	env: {} as Record<string, string>,
	loomSourceUrl: "https://cdn.loom.com/original.mp4",
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: mocks.where,
				innerJoin: () => ({ where: mocks.where }),
			}),
		}),
		update: () => ({ set: () => ({ where: mocks.write }) }),
		delete: () => ({ where: mocks.write }),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id" },
	videoUploads: { videoId: "videoId" },
	users: {},
	agentApiOperations: {},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		WEB_URL: "https://cap.example.com",
		MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
		...mocks.env,
	}),
}));
vi.mock("@cap/web-domain", () => ({
	Video: {
		VideoId: { make: (id: string) => id },
		Video: { decodeSync: (value: unknown) => value },
	},
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.getAccess },
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));
vi.mock("workflow", () => ({
	createHook: mocks.createHook,
	sleep: mocks.sleep,
	FatalError: class FatalError extends Error {},
	getWorkflowMetadata: () => ({ workflowRunId: "run-import" }),
	RetryableError: class RetryableError extends Error {},
}));

vi.mock("@/lib/loom-media-dispatch", () => ({
	recordLoomMediaDispatch: mocks.dispatch,
	isLoomMediaJobFailed: mocks.mediaJobFailed,
}));

import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";
import { processVideoWorkflow } from "@/workflows/process-video";

const payload = {
	videoId: "video",
	userId: "owner",
	rawFileKey: "owner/video/raw-upload.mp4",
	bucketId: null,
	loomVideoId: "loom-video",
};
const video = {
	id: "video",
	ownerId: "owner",
	source: { type: "webMP4" },
	createdAt: new Date(),
	updatedAt: new Date(),
};
const metadata = { duration: 30, width: 1920, height: 1080, fps: 30 };
const pending = { phase: "processing", processingProgress: 25 };

function storageError(cause: unknown) {
	return { _tag: "StorageError", cause: { _tag: "S3Error", cause } };
}

function s3Error(name: string, httpStatusCode: number) {
	return Object.assign(new Error(name), {
		name,
		$metadata: { httpStatusCode },
	});
}

describe("media processing workflows", () => {
	beforeEach(() => {
		mocks.hookDispose.mockReset();
		mocks.createHook.mockReset().mockImplementation(() => ({
			then: (resolve: (value: unknown) => void) =>
				resolve({ phase: "complete" }),
			dispose: mocks.hookDispose,
		}));
		mocks.rows = [];
		mocks.env = {};
		mocks.loomSourceUrl = "https://cdn.loom.com/original.mp4";
		mocks.where
			.mockReset()
			.mockImplementation(async () => mocks.rows.shift() ?? []);
		mocks.write.mockResolvedValue(undefined);
		mocks.getAccess.mockImplementation(() =>
			Effect.succeed([
				{
					getInternalSignedObjectUrl: mocks.get,
					getInternalPresignedPutUrl: mocks.put,
					headObject: mocks.head,
					deleteObject: mocks.remove,
				},
			]),
		);
		mocks.get.mockImplementation((key: string) =>
			Effect.succeed(`https://storage.example.com/${key}`),
		);
		mocks.put.mockImplementation((key: string) =>
			Effect.succeed(`https://storage.example.com/${key}?upload=1`),
		);
		mocks.head.mockImplementation(() =>
			Effect.succeed({ ContentLength: 2048 }),
		);
		mocks.remove.mockImplementation(() => Effect.void);
		mocks.dispatch.mockReset().mockResolvedValue(undefined);
		mocks.mediaJobFailed.mockReset().mockResolvedValue(true);
		mocks.sleep.mockResolvedValue(undefined);
		mocks.statusFetch.mockReset().mockImplementation(async () =>
			Response.json({
				loomMultipartUploads: true,
				loomImportMaxBytes: 10 * 1024 ** 3,
			}),
		);
		vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
			url.endsWith("/video/status")
				? mocks.statusFetch(url, init)
				: mocks.fetch(url, init),
		);
		mocks.fetch.mockReset().mockImplementation(async (url: string) => {
			if (url.startsWith("https://www.loom.com/")) {
				return Response.json({ url: mocks.loomSourceUrl });
			}
			if (
				url.startsWith("https://worker.example.com/") ||
				url.startsWith("https://media.example.com/loom-importer/")
			) {
				return Response.json({ jobId: "job-1", status: "queued" });
			}
			throw new Error("Video bytes must not pass through Vercel");
		});
	});

	it("dispatches an uploaded recording once while completion is delayed", async () => {
		mocks.rows = [
			[video],
			[{ ...pending, rawFileKey: payload.rawFileKey }],
			[video],
			[pending],
			[pending],
			[],
			[metadata],
			[video],
			[],
		];
		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
			metadata,
		});
		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(mocks.sleep.mock.calls).toEqual([[5_000], [10_000]]);
		expect(mocks.remove).toHaveBeenCalledWith(payload.rawFileKey);
	});

	it("marks deferred Loom originals so the worker accepts their decoder glitches", async () => {
		const loomVideo = {
			...video,
			metadata: {
				loomDeferredProcessing: {
					status: "started",
					rawFileKey: payload.rawFileKey,
				},
			},
		};
		mocks.rows = [
			[loomVideo],
			[{ ...pending, rawFileKey: payload.rawFileKey }],
			[loomVideo],
			[pending],
			[],
			[metadata],
			[loomVideo],
			[],
		];
		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		const body = JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body));
		expect(body.importedOriginal).toBe(true);
	});

	it("checks ordinary uploads strictly", async () => {
		mocks.rows = [
			[video],
			[{ ...pending, rawFileKey: payload.rawFileKey }],
			[video],
			[pending],
			[],
			[metadata],
			[video],
			[],
		];
		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		const body = JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body));
		expect(body.importedOriginal).toBeUndefined();
	});

	it("keeps uploaded source data when processing fails", async () => {
		mocks.rows = [
			[video],
			[{ ...pending, rawFileKey: payload.rawFileKey }],
			[video],
			[{ ...pending, processingError: "Worker failed" }],
			[video],
			[{ ...pending, processingError: "Worker failed" }],
			[video],
			[{ ...pending, processingError: "Worker failed" }],
		];
		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Worker failed",
		);
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.fetch).toHaveBeenCalledTimes(3);
		expect(mocks.sleep.mock.calls).toEqual([[15_000], [30_000]]);
	});

	it("recovers from a confirmed worker failure with a bounded durable retry", async () => {
		mocks.rows = [
			[video],
			[{ ...pending, rawFileKey: payload.rawFileKey }],
			[video],
			[{ ...pending, processingError: "Temporary storage failure" }],
			[video],
			[],
			[metadata],
			[video],
			[],
		];
		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.sleep.mock.calls).toEqual([[15_000]]);
	});

	it("sends Loom media directly to the worker with a required original destination", async () => {
		mocks.rows = [[video], [pending], [], [metadata]];
		await expect(importLoomVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.get).not.toHaveBeenCalled();
		const calls = mocks.fetch.mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[1]?.[0]).toBe("https://worker.example.com/video/import");
		expect(JSON.parse(calls[1]?.[1].body)).toMatchObject({
			videoUrl: "https://cdn.loom.com/original.mp4",
			sourcePresignedUrl:
				"https://storage.example.com/owner/video/raw-upload.mp4?upload=1",
			priority: "bulk",
		});
		expect(JSON.parse(calls[1]?.[1].body)).not.toHaveProperty("importPriority");
		expect(mocks.remove).not.toHaveBeenCalled();
	});

	describe("with the dedicated Loom importer", () => {
		const importerUrl = "https://media.example.com/loom-importer";
		const dispatchedBody = () => {
			const call = mocks.fetch.mock.calls.find(([url]) =>
				String(url).startsWith(importerUrl),
			);
			return call ? JSON.parse(call[1].body) : undefined;
		};

		beforeEach(() => {
			mocks.env = { LOOM_IMPORTER_URL: importerUrl };
		});

		it("sends HLS downloads to the importer and defers transcription", async () => {
			mocks.loomSourceUrl = "https://luna.loom.com/id/x/playlist.m3u8";
			mocks.rows = [[video], [], [metadata]];
			mocks.sleep.mockImplementation(() => new Promise(() => undefined));
			await expect(importLoomVideoWorkflow(payload)).resolves.toMatchObject({
				success: true,
			});
			expect(mocks.statusFetch.mock.calls.map(([url]) => url)).toEqual([
				"https://worker.example.com/video/status",
				`${importerUrl}/video/status`,
			]);
			expect(
				mocks.fetch.mock.calls.some(([url]) =>
					String(url).startsWith("https://worker.example.com/"),
				),
			).toBe(false);
			const body = dispatchedBody();
			expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe(
				`${importerUrl}/video/import`,
			);
			expect(body).toMatchObject({
				videoUrl: "https://luna.loom.com/id/x/playlist.m3u8",
				webhookUrl:
					"https://cap.example.com/api/webhooks/media-server/progress?retryable=true&signal=loom-import%3Avideo%3Arun-import%3A0&transcription=on-view&preview=on-view",
			});
			expect(mocks.createHook).toHaveBeenCalledWith({
				token: "loom-import:video:run-import:0",
			});
			expect(mocks.hookDispose).toHaveBeenCalledTimes(1);
			expect(body.previewGifPresignedUrl).toBeUndefined();
			expect(body.thumbnailPresignedUrl).toBeDefined();
			expect(body.sourcePresignedUrl).toBeUndefined();
			expect(body.sourceUpload).toBeUndefined();
			expect(body.importPriority).toBe("customer");
		});

		it("keeps operator redrives in the importer's bulk lane", async () => {
			mocks.loomSourceUrl = "https://luna.loom.com/id/x/playlist.m3u8";
			mocks.rows = [[video], [], [metadata]];
			mocks.sleep.mockImplementation(() => new Promise(() => undefined));
			await expect(
				importLoomVideoWorkflow({ ...payload, importPriority: "bulk" }),
			).resolves.toMatchObject({ success: true });
			expect(dispatchedBody()).toMatchObject({
				priority: "bulk",
				importPriority: "bulk",
			});
		});

		it.each([
			"https://luna.loom.com/id/x/playlist.mpd",
			"https://luna.loom.com/id/x/playlist.m3u8",
			"https://luna.loom.com/id/x/raw.webm",
		])("gives %s a WebM original destination", async (url) => {
			mocks.loomSourceUrl = url;
			mocks.rows = [[video], [pending], [], [metadata]];
			await importLoomVideoWorkflow(payload);
			expect(dispatchedBody()?.originalUpload).toEqual({
				key: "owner/video/raw-upload.webm",
				upload: {
					type: "put",
					url: "https://storage.example.com/owner/video/raw-upload.webm?upload=1",
				},
			});
			expect(mocks.put).toHaveBeenCalledWith("owner/video/raw-upload.webm", {
				ContentType: "video/webm",
			});
			expect(mocks.remove).toHaveBeenCalledWith("owner/video/raw-upload.webm");
		});

		it("does not keep a second copy of progressive MP4 downloads", async () => {
			mocks.rows = [[video], [pending], [], [metadata]];
			await importLoomVideoWorkflow(payload);
			const body = dispatchedBody();
			expect(body.videoUrl).toBe("https://cdn.loom.com/original.mp4");
			expect(body.sourcePresignedUrl).toBeUndefined();
			expect(body.originalUpload).toBeUndefined();
			expect(mocks.put).not.toHaveBeenCalledWith(
				payload.rawFileKey,
				expect.anything(),
				expect.anything(),
			);
		});

		it("keeps processing a preserved original on the media server", async () => {
			mocks.rows = [[video], [video], [], [metadata]];
			await importLoomVideoWorkflow({
				...payload,
				reuseExistingRawUpload: true,
			});
			expect(mocks.fetch).toHaveBeenCalledOnce();
			expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
				"https://worker.example.com/video/process",
			);
			const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1].body);
			expect(body.webhookUrl).not.toContain("transcription=on-view");
			expect(body.webhookUrl).not.toContain("preview=on-view");
			expect(body.previewGifPresignedUrl).toBeDefined();
		});

		it("waits for the importer when it cannot confirm Loom support", async () => {
			mocks.statusFetch.mockImplementation(async (url: string) =>
				url.startsWith(importerUrl)
					? new Response("unavailable", { status: 503 })
					: Response.json({
							loomMultipartUploads: true,
							loomImportMaxBytes: 10 * 1024 ** 3,
						}),
			);
			await expect(importLoomVideoWorkflow(payload)).rejects.toThrow(
				"Could not verify Loom import worker capabilities",
			);
			expect(dispatchedBody()).toBeUndefined();
		});
	});

	it("reuses a preserved Loom upload when retrying", async () => {
		mocks.rows = [[video], [video], [], [metadata]];
		await importLoomVideoWorkflow({ ...payload, reuseExistingRawUpload: true });
		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
			"https://worker.example.com/video/process",
		);
		expect(mocks.get).toHaveBeenCalledWith(
			payload.rawFileKey,
			expect.anything(),
		);
	});

	it("uses a fresh preflight source without requesting it again", async () => {
		const expires = Math.floor(Date.now() / 1000) + 7200;
		const loomDownloadUrl = `https://cdn.loom.com/original.mp4?Expires=${expires}`;
		mocks.rows = [[video], [pending], [], [metadata]];
		await importLoomVideoWorkflow({ ...payload, loomDownloadUrl });
		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(JSON.parse(mocks.fetch.mock.calls[0]?.[1].body).videoUrl).toBe(
			loomDownloadUrl,
		);
	});

	it("refreshes an expired preflight source before dispatch", async () => {
		mocks.rows = [[video], [pending], [], [metadata]];
		await importLoomVideoWorkflow({
			...payload,
			loomDownloadUrl: "https://cdn.loom.com/original.mp4?Expires=1",
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(mocks.fetch.mock.calls[1]?.[1].body).videoUrl).toBe(
			"https://cdn.loom.com/original.mp4",
		);
	});

	it.each([false, true])(
		"refreshes a source waiting for worker capacity only when it expires: %s",
		async (expiresDuringWait) => {
			const now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const expires = Math.floor(now / 1000) + 7200;
			const loomDownloadUrl = `https://cdn.loom.com/original.mp4?Expires=${expires}`;
			let workerAttempts = 0;
			mocks.rows = [[video], [video], [], [metadata]];
			mocks.fetch.mockImplementation(async (url: string) => {
				if (url.startsWith("https://www.loom.com/")) {
					return Response.json({ url: "https://cdn.loom.com/refreshed.mp4" });
				}
				workerAttempts++;
				return workerAttempts <= 2
					? Response.json(
							{ code: "SERVER_BUSY", error: "Server is busy" },
							{ status: 503 },
						)
					: Response.json({ jobId: "job-1" });
			});
			mocks.sleep.mockImplementationOnce(async () => {
				if (expiresDuringWait) clock.mockReturnValue(now + 2 * 60 * 60 * 1000);
			});
			try {
				await importLoomVideoWorkflow({ ...payload, loomDownloadUrl });
				expect(workerAttempts).toBe(3);
				expect(
					mocks.fetch.mock.calls.filter(([url]) =>
						String(url).startsWith("https://www.loom.com/"),
					),
				).toHaveLength(expiresDuringWait ? 1 : 0);
				expect(
					JSON.parse(mocks.fetch.mock.calls.at(-1)?.[1].body),
				).toMatchObject({
					videoUrl: expiresDuringWait
						? "https://cdn.loom.com/refreshed.mp4"
						: loomDownloadUrl,
					priority: "bulk",
				});
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("does not re-import from Loom when the preserved upload check fails transiently", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(storageError(s3Error("ServiceUnavailable", 503))),
		);
		mocks.rows = [[video]];
		await expect(
			importLoomVideoWorkflow({ ...payload, reuseExistingRawUpload: true }),
		).rejects.toThrow();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it("does not re-import from Loom when the preserved upload check hits a network error", async () => {
		mocks.head.mockReturnValue(
			Effect.fail(storageError(new Error("socket hang up"))),
		);
		mocks.rows = [[video]];
		await expect(
			importLoomVideoWorkflow({ ...payload, reuseExistingRawUpload: true }),
		).rejects.toThrow();
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it.each([
		["storage", storageError(s3Error("NotFound", 404))],
		[
			"Google Drive",
			{
				_tag: "StorageError",
				cause: Object.assign(new Error("Storage object not found"), {
					name: "GoogleDriveRequestError",
					status: 404,
				}),
			},
		],
	])(
		"re-imports from Loom when %s reports the preserved upload missing",
		async (_, error) => {
			mocks.head.mockReturnValue(Effect.fail(error));
			mocks.rows = [[video], [video], [pending], [], [metadata]];
			await expect(
				importLoomVideoWorkflow({ ...payload, reuseExistingRawUpload: true }),
			).resolves.toMatchObject({ success: true });
			expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe(
				"https://worker.example.com/video/import",
			);
		},
	);

	it("retries a failed Loom worker from its preserved original", async () => {
		mocks.rows = [
			[video],
			[{ ...pending, processingError: "Temporary processing failure" }],
			[video],
			[video],
			[],
			[metadata],
		];
		await importLoomVideoWorkflow(payload);
		expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([
			"https://www.loom.com/api/campaigns/sessions/loom-video/transcoded-url",
			"https://worker.example.com/video/import",
			"https://worker.example.com/video/process",
		]);
		expect(mocks.get).toHaveBeenCalledWith(
			payload.rawFileKey,
			expect.anything(),
		);
	});

	it("does not retry a failed workflow while its accepted worker is unconfirmed", async () => {
		mocks.mediaJobFailed.mockResolvedValue(false);
		mocks.rows = [
			[video],
			[{ ...pending, processingError: "Processing status interrupted" }],
		];
		await expect(importLoomVideoWorkflow(payload)).rejects.toThrow(
			"must be reconciled before retrying",
		);
		expect(mocks.mediaJobFailed).toHaveBeenCalledWith(
			"job-1",
			"video",
			"https://worker.example.com",
		);
		expect(
			mocks.fetch.mock.calls.filter(([url]) =>
				url.startsWith("https://worker.example.com/"),
			),
		).toHaveLength(1);
	});

	it("blocks an old worker before creating upload targets or dispatching", async () => {
		mocks.statusFetch.mockResolvedValue(Response.json({}));
		await expect(importLoomVideoWorkflow(payload)).rejects.toThrow(
			"must be updated for 10 GB",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("leaves an uncertain dispatch receipt after a worker request times out", async () => {
		mocks.rows = [[video]];
		mocks.fetch.mockImplementation(async (url: string) => {
			if (url.startsWith("https://www.loom.com/"))
				return Response.json({ url: "https://cdn.loom.com/original.mp4" });
			throw new Error("Response timed out after dispatch");
		});
		await expect(importLoomVideoWorkflow(payload)).rejects.toThrow("timed out");
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
		expect(mocks.dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-import",
				attemptId: "run-import:0",
				state: "uncertain",
			}),
		);
		expect(
			mocks.fetch.mock.calls.filter(([url]) =>
				String(url).startsWith("https://worker.example.com/"),
			),
		).toHaveLength(1);
	});

	it.each([
		[503, { error: "Upstream response unavailable" }],
		[200, {}],
	])(
		"holds an ambiguous HTTP %s worker response without redispatching",
		async (status, body) => {
			mocks.rows = [[video]];
			mocks.fetch.mockImplementation(async (url: string) =>
				url.startsWith("https://www.loom.com/")
					? Response.json({ url: "https://cdn.loom.com/original.mp4" })
					: Response.json(body, { status }),
			);
			await expect(importLoomVideoWorkflow(payload)).rejects.toThrow();
			expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ state: "uncertain" }),
			);
			expect(
				mocks.fetch.mock.calls.filter(([url]) =>
					url.startsWith("https://worker.example.com/"),
				),
			).toHaveLength(1);
		},
	);

	it("supports Loom streaming fallbacks without reading a nonexistent raw object", async () => {
		mocks.fetch.mockImplementation(async (url: string) =>
			Response.json(
				url.startsWith("https://www.loom.com/")
					? { url: "https://cdn.loom.com/master.m3u8" }
					: { jobId: "job-1" },
			),
		);
		mocks.rows = [[video], [], [metadata]];
		await importLoomVideoWorkflow(payload);
		expect(mocks.get).not.toHaveBeenCalled();
		expect(mocks.fetch.mock.calls.at(-1)?.[0]).toBe(
			"https://worker.example.com/video/process",
		);
		expect(JSON.parse(mocks.fetch.mock.calls.at(-1)?.[1].body)).toMatchObject({
			videoUrl: "https://cdn.loom.com/master.m3u8",
			inputExtension: ".m3u8",
		});
	});
});
