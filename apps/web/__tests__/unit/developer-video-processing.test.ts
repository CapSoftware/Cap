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
	internalDeveloperVideoUrl: async (key: string) => `https://storage/${key}`,
	developerVideoUploadUrl: async (key: string, contentType: string) =>
		`https://storage/put/${key}?type=${contentType}`,
}));
vi.mock("@/lib/media-client", () => ({
	probeVideoViaMediaServer: mocks.probe,
	startMediaServerVideoJob: mocks.startJob,
}));

const {
	applyDeveloperVideoProgress,
	claimDeveloperVideoProcessing,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
	prepareDeveloperVideoProcessing,
	releaseDeveloperVideoClaim,
} = await import("@/lib/developer-video-processing");

const HLS_PREFIX = "developer/app-1/video-1/encode-1/hls/";
const MP4_KEY = "developer/app-1/video-1/encode-1/video.mp4";
const POSTER_KEY = "developer/app-1/video-1/encode-1/poster.jpg";

const runningPart = (token: string) => ({
	state: "running" as const,
	token,
	jobId: "job-1",
	startedAt: 2_000,
});

const ladder = {
	encoder: "libx264",
	renditions: [
		{
			name: "1080p",
			width: 1920,
			height: 1080,
			bandwidth: 4_000_000,
			averageBandwidth: 3_000_000,
			codecs: "avc1.640028,mp4a.40.2",
			bytes: 5_000,
		},
		{
			name: "360p",
			width: 640,
			height: 360,
			bandwidth: 500_000,
			averageBandwidth: 400_000,
			codecs: "avc1.64001e,mp4a.40.2",
			bytes: 700,
		},
	],
	audio: { bytes: 300 },
};
const master = [
	"#EXTM3U",
	"#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080",
	"1080p.m3u8",
	"#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
	"360p.m3u8",
].join("\n");

function video() {
	if (!mocks.store.video) throw new Error("no video");
	return mocks.store.video;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = developerVideo();
	mocks.store.appDeleted = false;
	mocks.store.updates = [];
	mocks.head.mockImplementation(async (key: string) => {
		if (key === MP4_KEY) return { bytes: 2_000, contentType: "video/mp4" };
		if (key === POSTER_KEY) return { bytes: 50, contentType: "image/jpeg" };
		return { bytes: 1_000, contentType: "video/quicktime" };
	});
	mocks.readText.mockResolvedValue(master);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("developer video webhook", () => {
	it("ignores progress updates without touching the database", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ hls: runningPart("t1") }),
		});

		const result = await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "processing" },
			"hls",
			"t1",
		);

		expect(result).toEqual({ success: true, applied: false });
		expect(mocks.store.updates).toHaveLength(0);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "another attempt's token", part: "hls", token: "stale" },
		{ name: "a missing token", part: "hls", token: null },
		{ name: "an unknown part", part: "gif", token: "t1" },
		{ name: "a part that is not running", part: "mp4", token: "t1" },
	])("ignores a completion with $name", async ({ part, token }) => {
		mocks.store.video = developerVideo({
			processing: processingState({ hls: runningPart("t1") }),
		});

		const result = await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			part,
			token,
		);

		expect(result.applied).toBe(false);
		expect(mocks.store.updates).toHaveLength(0);
	});

	it("records the MP4 and keeps processing while renditions encode", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: runningPart("t-hls"),
				mp4: runningPart("t-mp4"),
			}),
		});

		const result = await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete" },
			"mp4",
			"t-mp4",
		);

		expect(result.applied).toBe(true);
		expect(video().status).toBe("processing");
		expect(video().processing?.mp4).toEqual({ state: "complete" });
		expect(video().storedBytes).toBe(1_000 + 2_000 + 50);
	});

	it("marks the video ready with its renditions once both parts are stored", async () => {
		mocks.store.video = developerVideo({
			duration: 999,
			width: 111,
			height: 222,
			fps: 5,
			processing: processingState({
				hls: runningPart("t-hls"),
				mp4: { state: "complete" },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			"hls",
			"t-hls",
		);

		expect(mocks.readText).toHaveBeenCalledWith(`${HLS_PREFIX}master.m3u8`);
		expect(video()).toMatchObject({
			status: "ready",
			errorReason: null,
			storedBytes: 1_000 + 6_000 + 2_000 + 50,
			duration: 12,
			width: 1920,
			height: 1080,
			fps: 30,
		});
		expect(video().renditions?.map((rendition) => rendition.name)).toEqual([
			"1080p",
			"360p",
		]);
	});

	it("retries when the stored master playlist does not match the result", async () => {
		mocks.readText.mockResolvedValue(null);
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: runningPart("t-hls"),
				mp4: { state: "complete" },
				attempts: { hls: 1, mp4: 1 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			"hls",
			"t-hls",
		);

		expect(video().processing?.hls).toEqual({ state: "pending" });
		expect(video().status).toBe("processing");
		expect(video().renditions).toBeNull();
	});

	it("stays playable from the MP4 when renditions fail for good", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: runningPart("t-hls"),
				mp4: { state: "complete" },
				attempts: { hls: 2, mp4: 1 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "encoder crashed" },
			"hls",
			"t-hls",
		);

		expect(video().status).toBe("ready");
		expect(video().processing?.hls).toEqual({
			state: "failed",
			reason: "encoder crashed",
		});
	});

	it("marks the video errored with the reason when nothing was produced", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "failed", reason: "no video track" },
				mp4: runningPart("t-mp4"),
				attempts: { hls: 2, mp4: 2 },
			}),
		});

		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "cancelled",
				message: "Server shutting down",
			},
			"mp4",
			"t-mp4",
		);

		expect(video()).toMatchObject({
			status: "errored",
			errorReason: "Server shutting down",
		});
	});

	it("fails the MP4 part when the output never reached storage", async () => {
		mocks.head.mockResolvedValue(null);
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: runningPart("t-mp4"),
				attempts: { hls: 0, mp4: 2 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete" },
			"mp4",
			"t-mp4",
		);

		expect(video().processing?.mp4).toEqual({
			state: "failed",
			reason: "Encoded MP4 was not stored",
		});
	});
});

describe("developer video dispatch", () => {
	it("claims a completed upload and gives it a playback id", async () => {
		mocks.store.video = developerVideo({
			status: "uploading",
			duration: null,
			playbackId: null,
			processing: null,
		});

		expect(
			await claimDeveloperVideoProcessing("video-1", { uploadCompleted: true }),
		).toBe("start");
		expect(video().status).toBe("processing");
		expect(video().playbackId).toMatch(/^[A-Za-z0-9_-]{24}$/);
		expect(video().processing).toMatchObject({
			probe: null,
			hls: { state: "pending" },
			mp4: { state: "pending" },
		});
		expect(await claimDeveloperVideoProcessing("video-1")).toBeNull();
	});

	it("puts the video back when the workflow could not be started", async () => {
		await releaseDeveloperVideoClaim("video-1", "start");

		expect(video()).toMatchObject({ status: "uploading", processing: null });
	});

	it("replaces client-supplied facts with what the media server probed", async () => {
		mocks.probe.mockResolvedValue({
			duration: 42.5,
			width: 2560,
			height: 1440,
			fps: 59.94,
		});
		mocks.store.video = developerVideo({
			duration: 999,
			width: 111,
			height: 222,
			fps: 5,
			processing: processingState({
				probe: null,
				bytes: { source: 0, hls: 0, mp4: 0, poster: 0 },
			}),
		});

		expect(await prepareDeveloperVideoProcessing("video-1")).toBe(true);
		expect(mocks.probe).toHaveBeenCalledWith(
			"https://storage/developer/app-1/video-1/video",
		);
		expect(video()).toMatchObject({
			duration: 42.5,
			width: 2560,
			height: 1440,
			fps: 60,
			storedBytes: 1_000,
		});
	});

	it("fails preparation when the upload has no video track", async () => {
		mocks.probe.mockResolvedValue({ duration: 3, width: 0, height: 0, fps: 0 });
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(prepareDeveloperVideoProcessing("video-1")).rejects.toThrow(
			"no video track",
		);
	});

	it("sends the ladder job upload targets under the video's own prefix", async () => {
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-9" });

		expect(await dispatchDeveloperVideoPart("video-1", "hls")).toBe(
			"dispatched",
		);

		const [path, body] = mocks.startJob.mock.calls[0] ?? [];
		expect(path).toBe("/video/ladder");
		expect(body).toMatchObject({
			videoId: "video-1",
			userId: "app-1",
			maxTier: "1080p",
			includeAudio: true,
			inputExtension: ".mov",
		});
		expect(Object.keys(body.uploads)).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"720p.m3u8",
			"720p.m4s",
			"360p.m3u8",
			"360p.m4s",
			"audio.m3u8",
			"audio.m4s",
		]);
		for (const [name, url] of Object.entries<string>(body.uploads)) {
			expect(url).toContain(`https://storage/put/${HLS_PREFIX}${name}`);
		}
		const hls = video().processing?.hls;
		expect(hls).toMatchObject({ state: "running", jobId: "job-9" });
		expect(body.webhookUrl).toBe(
			`https://web.example/api/webhooks/media-server/progress?developerVideo=hls&token=${hls?.state === "running" ? hls.token : ""}`,
		);
	});

	it("caps the MP4 job at the video's tier", async () => {
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-9" });
		mocks.store.video = developerVideo({
			processing: processingState({
				probe: { duration: 12, width: 3840, height: 2160, fps: 30 },
			}),
		});

		await dispatchDeveloperVideoPart("video-1", "mp4");

		const [path, body] = mocks.startJob.mock.calls[0] ?? [];
		expect(path).toBe("/video/process");
		expect(body).toMatchObject({ maxWidth: 1920, maxHeight: 1920 });
		expect(body.outputPresignedUrl).toContain(MP4_KEY);
		expect(body.thumbnailPresignedUrl).toContain(POSTER_KEY);
	});

	it("parks adaptive streaming when the media server has no ladder endpoint", async () => {
		mocks.startJob.mockResolvedValue({ status: "unavailable" });

		expect(await dispatchDeveloperVideoPart("video-1", "hls")).toBe(
			"unavailable",
		);
		expect(video().processing?.hls).toMatchObject({ state: "unavailable" });
		expect(video().status).toBe("processing");
	});

	it("gives the attempt back when the media server is busy", async () => {
		mocks.startJob.mockResolvedValue({ status: "busy" });

		expect(await dispatchDeveloperVideoPart("video-1", "mp4")).toBe("busy");
		expect(video().processing?.mp4).toEqual({ state: "pending" });
		expect(video().processing?.attempts.mp4).toBe(0);
	});

	it("does not dispatch a part twice", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ mp4: runningPart("t-mp4") }),
		});

		expect(await dispatchDeveloperVideoPart("video-1", "mp4")).toBe("skipped");
		expect(mocks.startJob).not.toHaveBeenCalled();
	});

	it("marks unfinished parts failed when the workflow gives up", async () => {
		await failDeveloperVideoProcessing("video-1", "Video processing timed out");

		expect(video()).toMatchObject({
			status: "errored",
			errorReason: "Video processing timed out",
		});
	});
});
