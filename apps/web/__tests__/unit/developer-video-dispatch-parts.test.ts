import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	head: vi.fn(),
	readText: vi.fn(),
	probe: vi.fn(),
	startJob: vi.fn(),
	charge: vi.fn(),
	sniff: vi.fn(),
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
		MEDIA_SERVER_WEBHOOK_URL: undefined,
	}),
}));
vi.mock("@/lib/developer-video-storage", () => ({
	headDeveloperVideoObject: mocks.head,
	readDeveloperVideoText: mocks.readText,
	deleteDeveloperVideoObjects: vi.fn(),
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
	internalDeveloperVideoUrl: async (key: string) => `https://storage/${key}`,
	developerVideoUploadUrl: async (key: string, contentType: string) =>
		`https://storage/put/${key}?type=${contentType}`,
}));
vi.mock("@/lib/developer-video-charge", () => ({
	DEVELOPER_VIDEO_MAX_DURATION_SECONDS: 4 * 60 * 60,
	chargeDeveloperVideoUpload: mocks.charge,
}));
vi.mock("@/lib/media-client", () => ({
	MEDIA_SERVER_SHUTDOWN_MESSAGE: "Server shutting down",
	tryProbeVideoViaMediaServer: mocks.probe,
	startMediaServerVideoJob: mocks.startJob,
	readMediaServerVideoJob: vi.fn(),
}));
vi.mock("@/lib/media-container", () => ({
	sniffMediaUrl: mocks.sniff,
}));

const {
	applyDeveloperVideoProgress,
	dispatchDeveloperVideoParts,
	prepareDeveloperVideoProcessing,
} = await import("@/lib/developer-video-processing");

const SOURCE = "developer/app-1/video-1/video";

function video() {
	if (!mocks.store.video) throw new Error("no video");
	return mocks.store.video;
}

const sourceHeads = () =>
	mocks.head.mock.calls.filter(([key]) => key === SOURCE).length;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = developerVideo();
	mocks.store.appDeleted = false;
	mocks.store.updates = [];
	mocks.head.mockResolvedValue({
		bytes: 1_000,
		contentType: "video/quicktime",
	});
	mocks.sniff.mockResolvedValue("media");
	mocks.charge.mockResolvedValue("charged");
	mocks.startJob.mockImplementation(async (path: string) => ({
		status: "started",
		jobId: path === "/video/ladder" ? "job-hls" : "job-mp4",
	}));
});

describe("dispatching every due part at once", () => {
	it("begins both parts in one write and sends both with the source type it was given", async () => {
		const results = await dispatchDeveloperVideoParts("video-1", "encode-1", {
			contentType: "video/quicktime",
		});

		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		expect(mocks.store.updates[0]?.processing).toMatchObject({
			hls: { state: "running", jobId: null },
			mp4: { state: "running", jobId: null },
			attempts: { hls: 1, mp4: 1 },
		});
		expect(sourceHeads()).toBe(0);
		expect(mocks.startJob).toHaveBeenCalledTimes(2);
		for (const [, body] of mocks.startJob.mock.calls) {
			expect(body).toMatchObject({ inputExtension: ".mov", infra: true });
		}
		expect(video().processing).toMatchObject({
			hls: { state: "running", jobId: "job-hls" },
			mp4: { state: "running", jobId: "job-mp4" },
		});
		const tokens = mocks.startJob.mock.calls.map(
			([, body]) => new URL(body.webhookUrl).searchParams.get("token") ?? "",
		);
		expect(new Set(tokens).size).toBe(2);
	});

	it("reads the source type once for both parts when it was not given", async () => {
		await dispatchDeveloperVideoParts("video-1", "encode-1");

		expect(sourceHeads()).toBe(1);
		expect(mocks.startJob).toHaveBeenCalledTimes(2);
		for (const [, body] of mocks.startJob.mock.calls) {
			expect(body).toMatchObject({ inputExtension: ".mov" });
		}
	});

	it("only begins and sends the parts that are due", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: {
					state: "running",
					token: "other",
					jobId: "job-1",
					startedAt: Date.now(),
				},
			}),
		});

		await dispatchDeveloperVideoParts("video-1", "encode-1");

		expect(mocks.store.updates[0]?.processing).toMatchObject({
			hls: { state: "running", jobId: null },
			mp4: { state: "running", token: "other", jobId: "job-1" },
		});
		expect(mocks.startJob.mock.calls.map(([path]) => path)).toEqual([
			"/video/ladder",
		]);
		expect(sourceHeads()).toBe(1);
	});

	it("writes and sends nothing when no part is due", async () => {
		const now = Date.now();
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "running", token: "a", jobId: "j1", startedAt: now },
				mp4: { state: "running", token: "b", jobId: "j2", startedAt: now },
			}),
		});

		expect(await dispatchDeveloperVideoParts("video-1", "encode-1")).toEqual(
			[],
		);
		expect(mocks.store.updates).toEqual([]);
		expect(mocks.startJob).not.toHaveBeenCalled();
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("still sends one part when the other fails to start", async () => {
		mocks.startJob.mockImplementation(async (path: string) => {
			if (path === "/video/process") throw new Error("connection reset");
			return { status: "started", jobId: "job-hls" };
		});

		const results = await dispatchDeveloperVideoParts("video-1", "encode-1", {
			contentType: "video/mp4",
		});

		expect(results.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(video().processing).toMatchObject({
			hls: { state: "running", jobId: "job-hls" },
			mp4: { state: "running", jobId: null },
		});
	});

	it("leaves a stale encode alone", async () => {
		expect(await dispatchDeveloperVideoParts("video-1", "encode-2")).toEqual(
			[],
		);
		expect(mocks.store.updates).toEqual([]);
		expect(mocks.startJob).not.toHaveBeenCalled();
	});
});

describe("source facts from preparation", () => {
	it("reports the source it read so the parts need not read it again", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1920, height: 1080, fps: 30 },
		});
		const seen: { source?: { contentType: string | null } | null } = {};

		expect(
			await prepareDeveloperVideoProcessing("video-1", "encode-1", seen),
		).toBe("ready");

		expect(seen.source).toEqual({
			bytes: 1_000,
			contentType: "video/quicktime",
		});
		expect(sourceHeads()).toBe(1);
	});

	it("reports nothing when the probe was already done", async () => {
		const seen: { source?: { contentType: string | null } | null } = {};

		expect(
			await prepareDeveloperVideoProcessing("video-1", "encode-1", seen),
		).toBe("ready");

		expect(seen.source).toBeUndefined();
		expect(mocks.head).not.toHaveBeenCalled();
	});
});

describe("settling a finished part", () => {
	const running = (token: string) => ({
		state: "running" as const,
		token,
		jobId: "job-1",
		startedAt: 2_000,
	});

	it("asks for the poster and the MP4 at the same time", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ mp4: running("t1") }),
		});
		const pending: Array<() => void> = [];
		mocks.head.mockImplementation(
			(key: string) =>
				new Promise((resolve) => {
					pending.push(() =>
						resolve({
							bytes: key.endsWith(".mp4") ? 2_000 : 50,
							contentType: null,
						}),
					);
				}),
		);

		const settling = applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete" },
			"mp4",
			"t1",
		);
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		for (const resolve of pending) resolve();

		expect(await settling).toEqual({ success: true, applied: true });
		expect(video().processing?.mp4).toMatchObject({ state: "complete" });
		expect(video().processing?.bytes).toMatchObject({ mp4: 2_000, poster: 50 });
	});

	it("asks for the poster and the master playlist at the same time", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ hls: running("t2") }),
		});
		const pending: Array<() => void> = [];
		mocks.head.mockImplementation(
			() =>
				new Promise((resolve) => {
					pending.push(() => resolve({ bytes: 50, contentType: null }));
				}),
		);
		mocks.readText.mockImplementation(
			() =>
				new Promise((resolve) => {
					pending.push(() =>
						resolve(
							[
								"#EXTM3U",
								"#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080",
								"1080p.m3u8",
							].join("\n"),
						),
					);
				}),
		);

		const settling = applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "complete",
				ladder: {
					encoder: "libx264",
					renditions: [
						{
							name: "1080p",
							width: 1920,
							height: 1080,
							bandwidth: 4_000_000,
							bytes: 5_000,
						},
					],
					audio: { bytes: 300 },
				},
			},
			"hls",
			"t2",
		);
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		for (const resolve of pending) resolve();

		expect(await settling).toEqual({ success: true, applied: true });
		expect(video().processing?.hls).toMatchObject({ state: "complete" });
	});
});
