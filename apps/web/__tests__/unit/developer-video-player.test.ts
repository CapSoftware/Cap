import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	standing: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const database = await createDeveloperVideoDatabase(mocks.store);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));
vi.mock("@/lib/developer-video-storage", () => ({}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraAppStanding: mocks.standing,
}));

const { loadDeveloperVideoPlayer } = await import(
	"@/lib/developer-video-player"
);

const PLAYBACK_ID = "playback-id-0123456789ab";
const BASE = `https://web.example/api/developer/playback/${PLAYBACK_ID}`;

const ready = (overrides = {}) =>
	developerVideo({
		name: "Launch demo",
		status: "ready",
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
		}),
		...overrides,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = ready();
	mocks.store.appDeleted = false;
	mocks.standing.mockResolvedValue({ state: "active", pausesAt: null });
});

describe("developer video player data", () => {
	it("plays the adaptive stream with the MP4 behind it and the poster", async () => {
		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toEqual({
			kind: "playing",
			name: "Launch demo",
			width: 1920,
			height: 1080,
			source: { hls: `${BASE}/master.m3u8`, mp4: `${BASE}/video.mp4` },
			poster: `${BASE}/poster.jpg`,
		});
		expect(mocks.standing).toHaveBeenCalledWith("app-1");
	});

	it("plays the MP4 while the adaptive stream is still encoding", async () => {
		mocks.store.video = ready({
			processing: processingState({
				hls: {
					state: "running",
					token: "t-hls",
					jobId: "job-1",
					startedAt: 1_000,
				},
				mp4: { state: "complete", output: "mp4-out" },
			}),
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			kind: "playing",
			source: { hls: undefined, mp4: `${BASE}/video.mp4` },
			poster: null,
		});
	});

	it("plays the adaptive stream when the MP4 has not arrived", async () => {
		mocks.store.video = ready({
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
			}),
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			kind: "playing",
			source: { hls: `${BASE}/master.m3u8`, mp4: undefined },
		});
	});

	it("keeps the frame of a portrait video", async () => {
		mocks.store.video = ready({ width: 1080, height: 1920 });

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			width: 1080,
			height: 1920,
		});
	});

	it("waits while the video is processing", async () => {
		mocks.store.video = developerVideo({ status: "processing" });

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toEqual({
			kind: "processing",
			uploading: false,
			name: "Untitled",
			width: 1920,
			height: 1080,
		});
	});

	it("waits in a 16:9 frame while the upload has not finished", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			processing: null,
			duration: null,
			width: null,
			height: null,
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toEqual({
			kind: "processing",
			uploading: true,
			name: "Untitled",
			width: 16,
			height: 9,
		});
	});

	it("shows why processing failed", async () => {
		mocks.store.video = developerVideo({
			status: "errored",
			errorReason: "This file has no video track.",
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			kind: "failed",
			reason: "This file has no video track.",
		});
	});

	it("still says a video failed when no reason was recorded", async () => {
		mocks.store.video = developerVideo({ status: "errored" });

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			kind: "failed",
			reason: "This video could not be processed.",
		});
	});

	it("offers nothing to play while the app is paused", async () => {
		mocks.standing.mockResolvedValue({
			state: "paused",
			pausesAt: new Date("2026-11-01T00:00:00Z"),
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toEqual({
			kind: "paused",
			name: "Launch demo",
			width: 1920,
			height: 1080,
		});
	});

	it("keeps playing through the grace period", async () => {
		mocks.standing.mockResolvedValue({
			state: "grace",
			pausesAt: new Date("2026-12-01T00:00:00Z"),
		});

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toMatchObject({
			kind: "playing",
		});
	});

	it("finds nothing for a deleted video", async () => {
		mocks.store.video = ready({ deletedAt: new Date("2026-11-02T00:00:00Z") });

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toBeNull();
		expect(mocks.standing).not.toHaveBeenCalled();
	});

	it("finds nothing once the app is deleted", async () => {
		mocks.store.appDeleted = true;

		expect(await loadDeveloperVideoPlayer(PLAYBACK_ID)).toBeNull();
	});

	it("finds nothing for an unknown playback ID", async () => {
		expect(
			await loadDeveloperVideoPlayer("another-playback-id-0000"),
		).toBeNull();
	});

	it("does not accept a video ID in place of the playback ID", async () => {
		expect(await loadDeveloperVideoPlayer("video-1")).toBeNull();

		mocks.store.video = ready({ id: "a-video-id-of-20-chars" });
		expect(await loadDeveloperVideoPlayer("a-video-id-of-20-chars")).toBeNull();
	});

	it("does not query for a malformed playback ID", async () => {
		mocks.store.video = ready({ playbackId: "../../etc/passwd-0123" });

		expect(await loadDeveloperVideoPlayer("../../etc/passwd-0123")).toBeNull();
	});
});
