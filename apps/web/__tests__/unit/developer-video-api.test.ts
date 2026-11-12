import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	appId: "app-1",
	playbackUrl: undefined as string | undefined,
	redrive: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const database = await createDeveloperVideoDatabase(mocks.store);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://web.example",
		INFRA_PLAYBACK_URL: mocks.playbackUrl,
	}),
}));
vi.mock("@/lib/developer-video-start", () => ({
	redriveDeveloperVideoProcessing: mocks.redrive,
}));
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		withDeveloperSecretAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", mocks.appId);
			c.set("developerKeyType", "secret");
			await next();
		}),
	};
});

const { app } = await import("@/app/api/developer/v1/[...route]/videos");

const BASE =
	"https://web.example/api/developer/playback/playback-id-0123456789ab";
const PAGE = "https://web.example/dev/playback-id-0123456789ab";
const ready = () =>
	developerVideo({
		status: "ready",
		storedBytes: 9_000,
		renditions: [
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bitrate: 3_000_000,
				bytes: 5_000,
				codecs: "avc1.640028,mp4a.40.2",
			},
		],
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
			bytes: { source: 1_000, hls: 5_000, mp4: 2_950, poster: 50 },
		}),
	});

async function get(path: string) {
	const response = await app.request(path);
	return { status: response.status, body: await response.json() };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = ready();
	mocks.store.updates = [];
	mocks.appId = "app-1";
	mocks.playbackUrl = undefined;
	mocks.redrive.mockResolvedValue(false);
});

describe("developer video API", () => {
	it("returns status, playback URLs and renditions alongside the existing fields", async () => {
		const { status, body } = await get("/video-1");

		expect(status).toBe(200);
		expect(body.data).toEqual({
			id: "video-1",
			appId: "app-1",
			externalUserId: null,
			name: "Untitled",
			duration: 12,
			width: 1920,
			height: 1080,
			fps: 30,
			transcriptionStatus: null,
			metadata: null,
			status: "ready",
			playbackId: "playback-id-0123456789ab",
			maxResolutionTier: "1080p",
			renditions: [
				{
					name: "1080p",
					width: 1920,
					height: 1080,
					bitrate: 3_000_000,
					bytes: 5_000,
					codecs: "avc1.640028,mp4a.40.2",
				},
			],
			storedBytes: 9_000,
			errorReason: null,
			deletedAt: null,
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			hlsUrl: `${BASE}/master.m3u8`,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
	});

	it("lists videos in the same shape", async () => {
		const { body } = await get("/");

		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			status: "ready",
			hlsUrl: `${BASE}/master.m3u8`,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
		expect(body.data[0]).not.toHaveProperty("processing");
	});

	it("keeps the storage key out of get and list responses", async () => {
		for (const path of ["/video-1", "/"]) {
			const { body } = await get(path);
			expect(JSON.stringify(body)).not.toContain("s3Key");
			expect(JSON.stringify(body)).not.toContain("developer/app-1");
		}
	});

	it("returns exactly the fields the OpenAPI description lists", async () => {
		const { developerOpenApiSpec } = await import("@/lib/developer-openapi");
		const schemas = developerOpenApiSpec("https://cap.so").components.schemas;

		const video = await get("/video-1");
		expect(Object.keys(video.body.data).sort()).toEqual(
			Object.keys(schemas.DeveloperVideo.properties).sort(),
		);
		const status = await get("/video-1/status");
		expect(Object.keys(status.body.data).sort()).toEqual(
			Object.keys(schemas.VideoStatus.properties).sort(),
		);
	});

	describe("list filters", () => {
		beforeEach(() => {
			mocks.store.video = { ...ready(), externalUserId: "user-1" };
		});

		it.each([
			["userId=user-1", 1],
			["externalUserId=user-1", 1],
			["userId=user-1&externalUserId=user-1", 1],
			["userId=user-2", 0],
			["externalUserId=user-2", 0],
			["limit=1&offset=0", 1],
		])("applies ?%s", async (query, count) => {
			const { status, body } = await get(`/?${query}`);

			expect(status).toBe(200);
			expect(body.data).toHaveLength(count);
		});

		it.each([
			["externalUserid=user-2", "unknown_parameter"],
			["userid=user-2", "unknown_parameter"],
			["user_id=user-2", "unknown_parameter"],
			["limit=0", "invalid_limit"],
			["limit=abc", "invalid_limit"],
			["limit=-1", "invalid_limit"],
			["limit=101", "invalid_limit"],
			["offset=abc", "invalid_offset"],
			["offset=-5", "invalid_offset"],
			["userId=user-1&externalUserId=user-2", "conflicting_parameters"],
		])("refuses ?%s rather than listing every video", async (query, code) => {
			const { status, body } = await get(`/?${query}`);

			expect(status).toBe(400);
			expect(body).toMatchObject({ code });
			expect(typeof body.error).toBe("string");
			expect(typeof body.hint).toBe("string");
			expect(body).not.toHaveProperty("data");
		});
	});

	describe("not found", () => {
		it.each([
			["GET", "/missing"],
			["GET", "/missing/status"],
			["DELETE", "/missing"],
		])("gives %s %s a code and a hint", async (method, path) => {
			const response = await app.request(path, { method });

			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({
				error: "Video not found",
				code: "video_not_found",
				hint: expect.stringContaining("belongs to this app"),
			});
		});

		it("hides a deleted video from get and status", async () => {
			mocks.store.video = { ...ready(), deletedAt: new Date() };

			for (const path of ["/video-1", "/video-1/status"]) {
				const { status, body } = await get(path);
				expect(status).toBe(404);
				expect(body.code).toBe("video_not_found");
			}
		});
	});

	describe("delete", () => {
		const remove = (path = "/video-1") =>
			app.request(path, { method: "DELETE" });

		it("deletes a video", async () => {
			const response = await remove();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(mocks.store.updates).toEqual([{ deletedAt: expect.any(Date) }]);
		});

		it("answers a repeated delete with success and leaves the row alone", async () => {
			const first = await remove();
			const deletedAt = mocks.store.video?.deletedAt;
			const second = await remove();

			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ success: true });
			expect(mocks.store.updates).toHaveLength(1);
			expect(mocks.store.video?.deletedAt).toBe(deletedAt);
		});

		it("still answers 404 for a video of another app, deleted or not", async () => {
			for (const deletedAt of [null, new Date()]) {
				mocks.store.video = { ...ready(), appId: "app-2", deletedAt };

				const response = await remove();

				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					code: "video_not_found",
				});
			}
			expect(mocks.store.updates).toHaveLength(0);
		});

		it("answers 404 for a video that never existed", async () => {
			mocks.store.video = null;

			const response = await remove();

			expect(response.status).toBe(404);
			expect(mocks.store.updates).toHaveLength(0);
		});
	});

	it("links the player page by playback ID, never by video ID", async () => {
		const { body } = await get("/video-1");

		expect(body.data.shareUrl).not.toContain(body.data.id);
		expect(body.data.embedUrl).not.toContain(body.data.id);
	});

	it("links the player page before the video is ready", async () => {
		mocks.store.video = developerVideo({ status: "processing" });

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({
			hlsUrl: null,
			shareUrl: PAGE,
			embedUrl: `${PAGE}/embed`,
		});
	});

	it("has no player page for a video without a playback ID", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: null,
			processing: null,
		});

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({ shareUrl: null, embedUrl: null });
	});

	it("keeps the status endpoint's fields and adds playback", async () => {
		const { body } = await get("/video-1/status");

		expect(body.data).toEqual({
			id: "video-1",
			duration: 12,
			width: 1920,
			height: 1080,
			transcriptionStatus: null,
			ready: true,
			status: "ready",
			errorReason: null,
			playbackId: "playback-id-0123456789ab",
			renditions: ready().renditions,
			hlsUrl: `${BASE}/master.m3u8`,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
		});
	});

	it("keeps a video uploaded before encoding existed ready", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: null,
			processing: null,
			updatedAt: new Date(Date.now() - 60 * 60_000),
		});
		mocks.redrive.mockImplementation(async () => {
			throw new Error("a legacy video must not be re-encoded on read");
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: true,
			status: "uploading",
			hlsUrl: null,
			mp4Url: null,
		});
	});

	it("does not call an unfinished upload ready", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			playbackId: "playback-id-0123456789ab",
			duration: null,
			processing: null,
		});

		const { body } = await get("/video-1/status");

		expect(body.data.ready).toBe(false);
	});

	it("offers no URLs until the video is ready", async () => {
		mocks.store.video = developerVideo({
			status: "processing",
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
			}),
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: false,
			status: "processing",
			hlsUrl: null,
			mp4Url: null,
			posterUrl: null,
			renditions: [],
		});
	});

	it("offers the MP4 while adaptive streaming is still encoding", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				hls: {
					state: "running",
					token: "t-hls",
					jobId: "job-1",
					startedAt: Date.now(),
				},
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
			}),
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: true,
			status: "ready",
			hlsUrl: null,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			renditions: [],
		});
		expect(mocks.redrive).not.toHaveBeenCalled();
	});

	it("offers only the MP4 while adaptive streaming is unavailable", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				hls: { state: "unavailable", reason: "not deployed", retryAt: 0 },
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		const { body } = await get("/video-1");

		expect(body.data).toMatchObject({
			status: "ready",
			hlsUrl: null,
			mp4Url: `${BASE}/video.mp4`,
			posterUrl: `${BASE}/poster.jpg`,
			renditions: [],
		});
		expect(mocks.redrive).toHaveBeenCalledExactlyOnceWith("video-1");
	});

	it("reports the error reason for a failed video", async () => {
		mocks.store.video = developerVideo({
			status: "errored",
			errorReason: "Uploaded file has no video track",
		});

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({
			ready: false,
			status: "errored",
			errorReason: "Uploaded file has no video track",
		});
		expect(mocks.redrive).not.toHaveBeenCalled();
	});

	it("tells the owner about a credit shortfall the public page keeps to itself", async () => {
		const errorReason =
			"Not enough credit to store this video at its measured length and size. Add at least $0.05 of credit and upload it again.";
		mocks.store.video = developerVideo({ status: "errored", errorReason });

		const { body } = await get("/video-1/status");

		expect(body.data).toMatchObject({ status: "errored", errorReason });
	});

	it("builds URLs on the configured playback hostname", async () => {
		mocks.playbackUrl = "https://stream.example/";

		const { body } = await get("/video-1");

		expect(body.data.hlsUrl).toBe(
			"https://stream.example/playback-id-0123456789ab/master.m3u8",
		);
	});

	it("does not return another app's video", async () => {
		mocks.appId = "app-2";

		expect((await get("/video-1")).status).toBe(404);
		expect((await get("/video-1/status")).status).toBe(404);
	});
});
