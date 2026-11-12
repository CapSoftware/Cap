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
			s3Key: "developer/app-1/video-1/video",
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
		});
	});

	it("lists videos in the same shape", async () => {
		const { body } = await get("/");

		expect(body.data).toHaveLength(1);
		expect(body.data[0]).toMatchObject({
			status: "ready",
			hlsUrl: `${BASE}/master.m3u8`,
		});
		expect(body.data[0]).not.toHaveProperty("processing");
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
