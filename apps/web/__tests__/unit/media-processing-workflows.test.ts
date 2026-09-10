import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	where: vi.fn(),
	write: vi.fn(),
	getAccess: vi.fn(),
	get: vi.fn(),
	put: vi.fn(),
	head: vi.fn(),
	remove: vi.fn(),
	fetch: vi.fn(),
	sleep: vi.fn(),
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
	sleep: mocks.sleep,
	FatalError: class FatalError extends Error {},
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
	source: { type: "webMP4" },
	createdAt: new Date(),
	updatedAt: new Date(),
};
const metadata = { duration: 30, width: 1920, height: 1080, fps: 30 };
const pending = { phase: "processing", processingProgress: 25 };

describe("media processing workflows", () => {
	beforeEach(() => {
		mocks.rows = [];
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
		mocks.sleep.mockResolvedValue(undefined);
		vi.stubGlobal("fetch", mocks.fetch);
		mocks.fetch.mockReset().mockImplementation(async (url: string) => {
			if (url.startsWith("https://www.loom.com/")) {
				return Response.json({ url: "https://cdn.loom.com/original.mp4" });
			}
			if (url.startsWith("https://worker.example.com/")) {
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
		expect(mocks.remove).not.toHaveBeenCalled();
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
