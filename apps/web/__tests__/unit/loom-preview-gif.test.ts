import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updates: [] as unknown[],
	affectedRows: [] as number[],
	env: {
		LOOM_IMPORTER_URL: "https://media.example.com/loom-importer",
		MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
	} as Record<string, string | undefined>,
	fetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({
	db: () => ({
		update: () => ({
			set: (values: unknown) => ({
				where: async () => {
					mocks.updates.push(values);
					return [{ affectedRows: mocks.affectedRows.shift() ?? 1 }];
				},
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "v.id", metadata: "v.metadata" },
}));
vi.mock("@cap/env", () => ({ serverEnv: () => mocks.env }));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (effect: Parameters<typeof Effect.runPromise>[0]) =>
			Effect.runPromise(effect),
	};
});

import {
	ensureLoomPreviewGif,
	isLoomPreviewDue,
	LOOM_PREVIEW_RETRY_MS,
	startLoomPreviewGif,
} from "@/lib/loom-preview-gif";

const now = new Date("2026-10-24T12:00:00Z");
const video: Record<string, unknown> = {
	id: "videoaaaaaaaaaa",
	ownerId: "owneraaaaaaaaaa",
	duration: Option.some(42),
};
const run = (overrides: Record<string, unknown> = {}) =>
	startLoomPreviewGif({
		video: video as never,
		getVideoUrl: async (key, expiresIn) =>
			`https://storage.example.com/${key}?get=${expiresIn}`,
		getPreviewPutUrl: async (key, expiresIn) =>
			`https://storage.example.com/${key}?put=${expiresIn}`,
		now,
		...overrides,
	});

beforeEach(() => {
	mocks.updates = [];
	mocks.affectedRows = [];
	mocks.env.LOOM_IMPORTER_URL = "https://media.example.com/loom-importer";
	mocks.fetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("isLoomPreviewDue", () => {
	it.each([
		[{ loomPreviewGif: { status: "pending" } }, true],
		[{ loomPreviewGif: { status: "complete" } }, false],
		[{}, false],
		[null, false],
		[
			{
				loomPreviewGif: {
					status: "started",
					startedAt: new Date(now.getTime() - 60_000).toISOString(),
				},
			},
			false,
		],
		[
			{
				loomPreviewGif: {
					status: "started",
					startedAt: new Date(
						now.getTime() - LOOM_PREVIEW_RETRY_MS - 1,
					).toISOString(),
				},
			},
			true,
		],
	])("%o -> %s", (metadata, expected) => {
		expect(isLoomPreviewDue(metadata, now.getTime())).toBe(expected);
	});
});

describe("startLoomPreviewGif", () => {
	it("asks the importer for one preview of the finished video", async () => {
		await expect(run()).resolves.toBe("complete");
		expect(mocks.fetch).toHaveBeenCalledOnce();
		const [url, init] = mocks.fetch.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://media.example.com/loom-importer/video/preview-gif",
		);
		expect(init.headers["x-media-server-secret"]).toBe("media-secret");
		expect(JSON.parse(init.body)).toEqual({
			videoUrl:
				"https://storage.example.com/owneraaaaaaaaaa/videoaaaaaaaaaa/result.mp4?get=900",
			previewGifPresignedUrl:
				"https://storage.example.com/owneraaaaaaaaaa/videoaaaaaaaaaa/preview/animated-preview.gif?put=900",
			duration: 42,
		});
		expect(mocks.updates).toHaveLength(2);
	});

	it("does nothing when another view already started it", async () => {
		mocks.affectedRows = [0];
		await expect(run()).resolves.toBe("already-started");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("lets the next view retry when the importer is busy", async () => {
		mocks.fetch.mockResolvedValue(new Response("busy", { status: 503 }));
		await expect(run()).resolves.toBe("busy");
		expect(mocks.updates).toHaveLength(2);
	});

	it("waits before retrying a failed preview", async () => {
		mocks.fetch.mockResolvedValue(new Response("busy", { status: 502 }));
		await expect(run()).resolves.toBe("failed");
		expect(mocks.updates).toHaveLength(1);
	});

	it("skips videos it cannot preview", async () => {
		await expect(
			run({ video: { ...video, duration: Option.none() } }),
		).resolves.toBe("unavailable");
		mocks.env.LOOM_IMPORTER_URL = undefined;
		await expect(run()).resolves.toBe("unavailable");
		expect(mocks.updates).toEqual([]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});

describe("ensureLoomPreviewGif", () => {
	const bucket = (exists: () => boolean) =>
		({
			getInternalSignedObjectUrl: (key: string) =>
				Effect.succeed(`https://storage.example.com/${key}`),
			getInternalPresignedPutUrl: (key: string) =>
				Effect.succeed(`https://storage.example.com/${key}?put`),
			headObject: () =>
				exists() ? Effect.succeed({}) : Effect.fail(new Error("missing")),
		}) as never;

	it("returns straight away for videos without a pending Loom preview", async () => {
		await expect(
			Effect.runPromise(
				ensureLoomPreviewGif(
					{ ...video, metadata: Option.none() } as never,
					bucket(() => true),
					"key",
				),
			),
		).resolves.toBe(false);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("renders the first pending preview before answering", async () => {
		await expect(
			Effect.runPromise(
				ensureLoomPreviewGif(
					{
						...video,
						metadata: Option.some({ loomPreviewGif: { status: "pending" } }),
					} as never,
					bucket(() => false),
					"key",
				),
			),
		).resolves.toBe(true);
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});

	it("waits for a preview another view is rendering", async () => {
		vi.useFakeTimers();
		let ready = false;
		const pending = Effect.runPromise(
			ensureLoomPreviewGif(
				{
					...video,
					metadata: Option.some({
						loomPreviewGif: {
							status: "started",
							startedAt: new Date().toISOString(),
						},
					}),
				} as never,
				bucket(() => ready),
				"key",
			),
		);
		await vi.advanceTimersByTimeAsync(4_000);
		ready = true;
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(pending).resolves.toBe(true);
		expect(mocks.fetch).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});
