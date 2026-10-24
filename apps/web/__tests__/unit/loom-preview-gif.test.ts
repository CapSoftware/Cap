import { Option } from "effect";
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

import {
	isLoomPreviewDue,
	LOOM_PREVIEW_RETRY_MS,
	startLoomPreviewGif,
} from "@/lib/loom-preview-gif";

const now = new Date("2026-10-24T12:00:00Z");
const video = {
	id: "videoaaaaaaaaaa",
	ownerId: "owneraaaaaaaaaa",
	duration: Option.some(42),
} as never;
const run = (overrides: Record<string, unknown> = {}) =>
	startLoomPreviewGif({
		video,
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
