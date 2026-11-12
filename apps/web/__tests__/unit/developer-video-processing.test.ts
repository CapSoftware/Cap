import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	readJob: vi.fn(),
	charge: vi.fn(),
	deleteObjects: vi.fn(),
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
	deleteDeveloperVideoObjects: mocks.deleteObjects,
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
	readMediaServerVideoJob: mocks.readJob,
}));
vi.mock("@/lib/media-container", () => ({
	sniffMediaUrl: mocks.sniff,
}));

const {
	applyDeveloperVideoProgress,
	checkDeveloperVideoPart,
	claimDeveloperVideoProcessing,
	DeveloperVideoRejected,
	dispatchDeveloperVideoPart,
	failDeveloperVideoProcessing,
	prepareDeveloperVideoProcessing,
	readDeveloperVideoParts,
	releaseDeveloperVideoClaim,
	sweepSupersededDeveloperVideoOutputs,
} = await import("@/lib/developer-video-processing");

const ENCODE = "developer/app-1/video-1/encode-1";

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
		if (key.endsWith("/video.mp4")) {
			return { bytes: 2_000, contentType: "video/mp4" };
		}
		if (key.endsWith("/poster.jpg")) {
			return { bytes: 50, contentType: "image/jpeg" };
		}
		return { bytes: 1_000, contentType: "video/quicktime" };
	});
	mocks.readText.mockResolvedValue(master);
	mocks.charge.mockResolvedValue("charged");
	mocks.deleteObjects.mockResolvedValue(0);
	mocks.sniff.mockResolvedValue("media");
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

	it("makes the video ready on the MP4 while renditions still encode", async () => {
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
		expect(video().status).toBe("ready");
		expect(video().processing?.hls.state).toBe("running");
		expect(video().renditions).toBeNull();
		expect(video().processing?.mp4).toEqual({
			state: "complete",
			output: "t-mp4",
		});
		expect(video().processing?.poster).toEqual({ output: "t-mp4" });
		expect(mocks.head).toHaveBeenCalledWith(`${ENCODE}/t-mp4/video.mp4`);
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
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			"hls",
			"t-hls",
		);

		expect(mocks.readText).toHaveBeenCalledWith(
			`${ENCODE}/t-hls/hls/master.m3u8`,
		);
		expect(video().processing?.hls).toEqual({
			state: "complete",
			output: "t-hls",
		});
		expect(video()).toMatchObject({
			status: "ready",
			errorReason: null,
			storedBytes: 1_000 + 6_000 + 2_000 + 50 + 50,
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
				mp4: { state: "complete", output: "mp4-out" },
				attempts: { hls: 1, mp4: 1 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			"hls",
			"t-hls",
		);

		expect(video().processing?.hls).toEqual({ state: "pending" });
		expect(video().status).toBe("ready");
		expect(video().renditions).toBeNull();
	});

	it("stays playable from the MP4 when renditions fail for good", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: runningPart("t-hls"),
				mp4: { state: "complete", output: "mp4-out" },
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
			reason:
				"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
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
				message: "Processing cancelled by user",
			},
			"mp4",
			"t-mp4",
		);

		expect(video()).toMatchObject({
			status: "errored",
			errorReason:
				"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
		});
	});

	it("sends a part again without spending an attempt when its server shut down", async () => {
		const processing = processingState({
			hls: { state: "failed", reason: "no video track" },
			mp4: runningPart("t-mp4"),
			attempts: { hls: 2, mp4: 2 },
		});
		mocks.store.video = developerVideo({ processing });

		const result = await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "cancelled",
				message: "Server shutting down",
			},
			"mp4",
			"t-mp4",
		);

		expect(result).toEqual({ success: true, applied: true });
		expect(video().processing?.mp4).toEqual({ state: "pending" });
		expect(video().processing?.attempts.mp4).toBe(1);
		expect(video()).toMatchObject({ status: "processing", errorReason: null });

		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-2" });
		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"dispatched",
		);
		expect(video().processing?.attempts.mp4).toBe(2);
		expect(video().processing?.mp4).toMatchObject({
			state: "running",
			jobId: "job-2",
		});
	});

	it("spends an attempt on a real encode failure", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: runningPart("t-mp4"),
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "encoder crashed" },
			"mp4",
			"t-mp4",
		);

		expect(video().processing?.mp4).toEqual({ state: "pending" });
		expect(video().processing?.attempts.mp4).toBe(1);
		expect(video().processing?.lostJobs).toBeUndefined();

		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-2" });
		await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4");
		const second = video().processing?.mp4;
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "encoder crashed" },
			"mp4",
			second?.state === "running" ? second.token : null,
		);

		expect(video().processing?.attempts.mp4).toBe(2);
		expect(video().processing?.mp4).toEqual({
			state: "failed",
			reason:
				"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
		});
	});

	it("counts a shutdown as a failed attempt once the part has been lost three times", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "failed", reason: "no video track" },
				mp4: runningPart("t-mp4"),
				attempts: { hls: 2, mp4: 2 },
				lostJobs: { mp4: 3 },
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

		expect(video().processing?.mp4.state).toBe("failed");
		expect(video().status).toBe("errored");
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

describe("quiet encode jobs", () => {
	const NOW = Date.parse("2026-11-01T02:00:00Z");
	const QUIET_MS = 3 * 60 * 1000;
	const CONFIRM_MS = 60 * 1000;
	const quietPart = (token: string, quietFor = QUIET_MS) => ({
		state: "running" as const,
		token,
		jobId: `job-${token}`,
		startedAt: NOW - quietFor,
	});
	const check = (part: "hls" | "mp4") =>
		checkDeveloperVideoPart("video-1", "encode-1", part);

	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
	});

	afterEach(() => {
		vi.mocked(Date.now).mockRestore();
	});

	it("does not ask about a job before it has been quiet for three minutes", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4", QUIET_MS - 1_000),
				hls: quietPart("t-hls", QUIET_MS - 1_000),
			}),
		});

		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			mp4: "wait",
			hls: "wait",
		});
		expect(await check("mp4")).toBe("skipped");
		expect(await check("hls")).toBe("skipped");
		expect(mocks.readJob).not.toHaveBeenCalled();
		expect(mocks.store.updates).toHaveLength(0);
	});

	it("asks about a job by its id once it has been quiet for three minutes", async () => {
		mocks.readJob.mockResolvedValue({ status: "running" });
		mocks.store.video = developerVideo({
			processing: processingState({ mp4: quietPart("t-mp4") }),
		});

		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			mp4: "check",
			hls: "dispatch",
		});
		expect(await check("mp4")).toBe("waiting");
		expect(mocks.readJob.mock.calls).toEqual([["job-t-mp4", "video-1"]]);
	});

	it("never asks about a part that has no job id, has finished or is not started", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: { ...quietPart("t-mp4", 60_000), jobId: null },
				hls: { state: "complete", output: "hls-out" },
			}),
		});

		expect(await check("mp4")).toBe("skipped");
		expect(await check("hls")).toBe("skipped");

		mocks.store.video = developerVideo();
		expect(await check("mp4")).toBe("skipped");
		expect(mocks.readJob).not.toHaveBeenCalled();
		expect(mocks.store.updates).toHaveLength(0);
	});

	it("sends a job the media server lost again and leaves its attempt count alone", async () => {
		mocks.readJob.mockResolvedValue({ status: "missing" });
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-2" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4"),
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		expect(await check("mp4")).toBe("unconfirmed");
		vi.mocked(Date.now).mockReturnValue(NOW + CONFIRM_MS);
		expect(await check("mp4")).toBe("requeued");

		expect(video().processing?.mp4).toEqual({ state: "pending" });
		expect(video().processing?.attempts.mp4).toBe(0);
		expect(video().status).toBe("processing");
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			mp4: "dispatch",
		});

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"dispatched",
		);
		expect(video().processing?.attempts.mp4).toBe(1);
		expect(video().processing?.mp4).toEqual({
			state: "running",
			token: expect.any(String),
			jobId: "job-2",
			startedAt: NOW + CONFIRM_MS,
		});
		expect(mocks.startJob).toHaveBeenCalledTimes(1);
	});

	it("does not treat one not found answer as a lost job", async () => {
		mocks.readJob.mockResolvedValue({ status: "missing" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4"),
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		expect(await check("mp4")).toBe("unconfirmed");

		expect(video().processing?.mp4).toEqual({
			...quietPart("t-mp4"),
			notFoundAt: NOW,
		});
		expect(video().processing?.attempts.mp4).toBe(1);
		expect(video().processing?.lostJobs).toBeUndefined();
		expect(mocks.store.updates).toHaveLength(1);

		vi.mocked(Date.now).mockReturnValue(NOW + CONFIRM_MS - 1_000);
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			mp4: "check",
		});
		expect(await check("mp4")).toBe("unconfirmed");
		expect(mocks.readJob).toHaveBeenCalledTimes(2);
		expect(mocks.store.updates).toHaveLength(1);
		expect(video().processing?.mp4).toMatchObject({ state: "running" });
		expect(mocks.startJob).not.toHaveBeenCalled();
	});

	it("forgets a not found answer once the job answers that it is running", async () => {
		mocks.readJob.mockResolvedValueOnce({ status: "missing" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4"),
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		expect(await check("mp4")).toBe("unconfirmed");
		mocks.readJob.mockResolvedValueOnce({ status: "running" });
		vi.mocked(Date.now).mockReturnValue(NOW + 20_000);
		expect(await check("mp4")).toBe("waiting");

		expect(video().processing?.mp4).toEqual({
			...quietPart("t-mp4"),
			checkedAt: NOW + 20_000,
		});

		mocks.readJob.mockResolvedValue({ status: "missing" });
		vi.mocked(Date.now).mockReturnValue(NOW + 20_000 + QUIET_MS);
		expect(await check("mp4")).toBe("unconfirmed");
		expect(video().processing?.mp4).toMatchObject({
			state: "running",
			notFoundAt: NOW + 20_000 + QUIET_MS,
		});
		expect(video().processing?.attempts.mp4).toBe(1);
	});

	it("does not count an unanswered ask as proof that a job is lost or alive", async () => {
		mocks.readJob.mockResolvedValueOnce({ status: "missing" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4"),
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		expect(await check("mp4")).toBe("unconfirmed");
		mocks.readJob.mockResolvedValueOnce({ status: "unreachable" });
		vi.mocked(Date.now).mockReturnValue(NOW + CONFIRM_MS);
		expect(await check("mp4")).toBe("unreachable");

		expect(video().processing?.mp4).toEqual({
			...quietPart("t-mp4"),
			notFoundAt: NOW,
		});
		expect(mocks.store.updates).toHaveLength(1);
	});

	it("sends the lost output of a ready video again without waiting hours", async () => {
		mocks.readJob.mockResolvedValue({ status: "missing" });
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-2" });
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "mp4-out" },
				hls: quietPart("t-hls"),
				attempts: { hls: 1, mp4: 1 },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			mp4: "done",
			hls: "check",
		});
		expect(await check("hls")).toBe("unconfirmed");
		expect(video().status).toBe("ready");
		vi.mocked(Date.now).mockReturnValue(NOW + CONFIRM_MS);
		expect(await check("hls")).toBe("requeued");
		expect(video().status).toBe("ready");
		expect(video().processing?.hls).toEqual({ state: "pending" });
		expect(video().processing?.attempts.hls).toBe(0);

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);
		expect(video().status).toBe("ready");
		expect(video().processing?.mp4).toEqual({
			state: "complete",
			output: "mp4-out",
		});
	});

	it("does not send a lost job twice when two checks find it missing", async () => {
		const answers: Array<(job: { status: "missing" }) => void> = [];
		mocks.readJob.mockImplementation(
			() => new Promise((resolve) => answers.push(resolve)),
		);
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-2" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: { ...quietPart("t-mp4"), notFoundAt: NOW - CONFIRM_MS },
				attempts: { hls: 0, mp4: 1 },
			}),
		});

		const first = check("mp4");
		const second = check("mp4");
		await vi.waitFor(() => expect(answers).toHaveLength(2));
		answers[0]?.({ status: "missing" });
		expect(await first).toBe("requeued");
		answers[1]?.({ status: "missing" });
		expect(await second).toBe("skipped");

		expect(video().processing?.lostJobs).toEqual({ mp4: 1 });
		expect(video().processing?.attempts.mp4).toBe(0);
		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"dispatched",
		);
		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"skipped",
		);
		expect(mocks.startJob).toHaveBeenCalledTimes(1);
		expect(video().processing?.attempts.mp4).toBe(1);
	});

	it("keeps waiting for a job that is lost again after three free sends", async () => {
		mocks.readJob.mockResolvedValue({ status: "missing" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: { ...quietPart("t-mp4"), notFoundAt: NOW - CONFIRM_MS },
				attempts: { hls: 0, mp4: 1 },
				lostJobs: { mp4: 3 },
			}),
		});

		expect(await check("mp4")).toBe("waiting");

		expect(video().processing?.mp4).toEqual({
			...quietPart("t-mp4"),
			checkedAt: NOW,
		});
		expect(video().processing?.attempts.mp4).toBe(1);
		expect(video().status).toBe("processing");
	});

	it("keeps waiting for a slow job and asks again three minutes later", async () => {
		mocks.readJob.mockResolvedValue({ status: "running" });
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: quietPart("t-hls", 2 * 60 * 60 * 1000),
				attempts: { hls: 1, mp4: 0 },
			}),
		});

		expect(await check("hls")).toBe("waiting");

		expect(video().processing?.hls).toEqual({
			...quietPart("t-hls", 2 * 60 * 60 * 1000),
			checkedAt: NOW,
		});
		expect(video().processing?.attempts.hls).toBe(1);
		expect(video().status).toBe("processing");

		vi.mocked(Date.now).mockReturnValue(NOW + QUIET_MS - 1_000);
		expect(await check("hls")).toBe("skipped");
		expect(mocks.readJob).toHaveBeenCalledTimes(1);

		vi.mocked(Date.now).mockReturnValue(NOW + QUIET_MS);
		expect(await check("hls")).toBe("waiting");
		expect(mocks.readJob).toHaveBeenCalledTimes(2);
	});

	it("changes nothing when the media server cannot be asked", async () => {
		mocks.readJob.mockResolvedValue({ status: "unreachable" });
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: quietPart("t-mp4"),
				hls: quietPart("t-hls"),
				attempts: { hls: 2, mp4: 2 },
			}),
		});
		const before = structuredClone(video());

		expect(await check("mp4")).toBe("unreachable");
		expect(await check("hls")).toBe("unreachable");

		expect(mocks.store.updates).toHaveLength(0);
		expect(video()).toEqual(before);
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			mp4: "check",
			hls: "check",
		});
	});

	it.each([
		{
			name: "a finished MP4",
			part: "mp4" as const,
			report: { phase: "complete", metadata: { duration: 12 } },
		},
		{
			name: "finished renditions",
			part: "hls" as const,
			report: { phase: "complete", ladder },
		},
		{
			name: "an MP4 that never reached storage",
			part: "mp4" as const,
			report: { phase: "complete" },
			missingOutput: true,
		},
		{
			name: "a failed encode",
			part: "hls" as const,
			report: { phase: "error", error: "encoder crashed" },
		},
		{
			name: "a job cancelled by a shutdown",
			part: "mp4" as const,
			report: { phase: "cancelled", message: "Server shutting down" },
		},
	])(
		"stores $name exactly as its webhook would have",
		async ({ part, report, missingOutput }) => {
			const token = `t-${part}`;
			const payload = { videoId: "video-1", jobId: `job-${token}`, ...report };
			const start = () =>
				developerVideo({
					processing: processingState({
						mp4: quietPart("t-mp4"),
						hls: quietPart("t-hls"),
						attempts: { hls: 2, mp4: 2 },
					}),
				});
			if (missingOutput) mocks.head.mockResolvedValue(null);

			mocks.store.video = start();
			const delivered = await applyDeveloperVideoProgress(payload, part, token);
			const afterWebhook = structuredClone(video());
			const webhookUpdates = structuredClone(mocks.store.updates);

			mocks.store.video = start();
			mocks.store.updates = [];
			mocks.readJob.mockResolvedValue({
				status: "finished",
				progress: payload,
			});
			const checked = await check(part);

			expect(delivered.applied).toBe(true);
			expect(checked).toBe("settled");
			expect(afterWebhook.processing?.[part].state).not.toBe("running");
			expect(video()).toEqual(afterWebhook);
			expect(mocks.store.updates).toEqual(webhookUpdates);
		},
	);

	it("leaves a deleted video and a replaced encode alone", async () => {
		mocks.readJob.mockResolvedValue({ status: "missing" });
		mocks.store.video = developerVideo({
			deletedAt: new Date(NOW),
			processing: processingState({ mp4: quietPart("t-mp4") }),
		});

		expect(await check("mp4")).toBe("skipped");

		mocks.store.video = developerVideo({
			processing: processingState({ mp4: quietPart("t-mp4") }),
		});
		expect(await checkDeveloperVideoPart("video-1", "old-encode", "mp4")).toBe(
			"skipped",
		);

		mocks.store.video = developerVideo({
			status: "ready",
			playbackId: null,
			processing: null,
		});
		expect(await check("mp4")).toBe("skipped");

		expect(mocks.readJob).not.toHaveBeenCalled();
		expect(mocks.store.updates).toHaveLength(0);
	});
});

describe("developer video measured facts", () => {
	const unmeasured = (overrides = {}, duration = 999) =>
		developerVideo({
			duration,
			processing: processingState({
				probe: { duration: null, width: 1920, height: 1080, fps: null },
				hls: runningPart("t-hls"),
				mp4: runningPart("t-mp4"),
				...overrides,
			}),
		});

	it("takes the duration from the encoded MP4 when the source had none", async () => {
		mocks.store.video = unmeasured();

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", metadata: { duration: 40.8 } },
			"mp4",
			"t-mp4",
		);

		expect(video().processing?.mp4.state).toBe("complete");
		expect(video().processing?.probe?.duration).toBe(40.8);
		expect(video()).toMatchObject({ duration: 40.8, fps: null });
	});

	it("charges for a length that only the encoded output revealed", async () => {
		mocks.store.video = unmeasured({}, 60);

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", metadata: { duration: 480 } },
			"mp4",
			"t-mp4",
		);

		expect(mocks.charge).toHaveBeenCalledWith(
			expect.objectContaining({ videoId: "video-1", durationSeconds: 480 }),
		);
		expect(video().processing?.mp4.state).toBe("complete");
	});

	it("fails the video when the output's length can't be paid for", async () => {
		mocks.store.video = unmeasured({}, 60);
		mocks.charge.mockResolvedValue("insufficient");

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", metadata: { duration: 480 } },
			"mp4",
			"t-mp4",
		);

		expect(video().status).toBe("errored");
		expect(video().processing?.mp4.state).toBe("failed");
		expect(video().processing?.hls.state).toBe("failed");
		expect(video().errorReason).toContain("Not enough credit");
	});

	it("leaves the part running for a retry when the charge hits a temporary error", async () => {
		mocks.store.video = unmeasured({}, 60);
		mocks.charge.mockRejectedValue(new Error("connection reset"));

		await expect(
			applyDeveloperVideoProgress(
				{ videoId: "video-1", phase: "complete", metadata: { duration: 480 } },
				"mp4",
				"t-mp4",
			),
		).rejects.toThrow("connection reset");

		expect(video().status).toBe("processing");
		expect(video().processing?.mp4).toMatchObject({
			state: "running",
			token: "t-mp4",
		});
		expect(video().processing?.hls.state).toBe("running");
	});

	it("fails the video when the output is longer than the length limit", async () => {
		mocks.store.video = unmeasured({}, 60);

		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "complete",
				metadata: { duration: 5 * 60 * 60 },
			},
			"mp4",
			"t-mp4",
		);

		expect(mocks.charge).not.toHaveBeenCalled();
		expect(video().status).toBe("errored");
		expect(video().errorReason).toContain("4 hour limit");
	});

	it("takes the duration from the stored rendition playlist when the source had none", async () => {
		mocks.store.video = unmeasured();
		mocks.readText.mockImplementation(async (key: string) =>
			key.endsWith("/master.m3u8")
				? master
				: "#EXTM3U\n#EXTINF:4.000000,\n1080p.m4s\n#EXTINF:2.500000,\n1080p.m4s\n",
		);

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete", ladder },
			"hls",
			"t-hls",
		);

		expect(mocks.readText).toHaveBeenCalledWith(
			`${ENCODE}/t-hls/hls/1080p.m3u8`,
		);
		expect(video().processing?.hls.state).toBe("complete");
		expect(video().duration).toBe(6.5);
	});

	it("does not accept an output it cannot measure, so a ready video never keeps a declared duration", async () => {
		mocks.store.video = unmeasured({
			hls: { state: "failed", reason: "encoder crashed" },
			attempts: { hls: 2, mp4: 2 },
		});

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete" },
			"mp4",
			"t-mp4",
		);

		expect(video().processing?.mp4).toEqual({
			state: "failed",
			reason: "Encoded output has no measurable duration",
		});
		expect(video().status).toBe("errored");
	});

	it("restores measured values when the row is written again after processing", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			duration: 999,
			width: 111,
			height: 222,
			fps: 5,
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
				mp4: { state: "complete", output: "mp4-out" },
			}),
		});

		expect(
			await claimDeveloperVideoProcessing("video-1", { uploadCompleted: true }),
		).toBeNull();
		expect(video()).toMatchObject({
			status: "ready",
			duration: 12,
			width: 1920,
			height: 1080,
			fps: 30,
		});

		mocks.store.updates = [];
		await claimDeveloperVideoProcessing("video-1", { uploadCompleted: true });

		expect(mocks.store.updates).toHaveLength(0);
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

		const claim = await claimDeveloperVideoProcessing("video-1", {
			uploadCompleted: true,
		});

		expect(claim?.action).toBe("start");
		expect(claim?.encodeId).toBe(video().processing?.encodeId);
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
		await releaseDeveloperVideoClaim("video-1", {
			action: "start",
			encodeId: "encode-1",
		});

		expect(video()).toMatchObject({ status: "uploading", processing: null });
	});

	it("replaces client-supplied facts with what the media server probed", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 42.5, width: 2560, height: 1440, fps: 59.94 },
		});
		mocks.store.video = developerVideo({
			duration: 999,
			width: 111,
			height: 222,
			fps: 5,
			processing: processingState({
				probe: null,
				poster: null,
				bytes: { source: 0, hls: 0, mp4: 0, poster: 0 },
			}),
		});

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);
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

	it("charges for the probed length when the client under-reported it", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 480, width: 1920, height: 1080, fps: 30 },
		});
		mocks.store.video = developerVideo({
			duration: 120,
			processing: processingState({ probe: null }),
		});

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);
		expect(mocks.charge).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: "app-1",
				videoId: "video-1",
				durationSeconds: 480,
			}),
		);
		expect(video().duration).toBe(480);
	});

	it("does not encode a video the app cannot pay for in full", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 480, width: 1920, height: 1080, fps: 30 },
		});
		mocks.charge.mockResolvedValue("insufficient");
		mocks.store.video = developerVideo({
			duration: 120,
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("Not enough credit");
		expect(video().processing?.probe).toBeNull();
	});

	it("charges nothing more when the reported length was right", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 121.5, width: 1920, height: 1080, fps: 30 },
		});
		mocks.store.video = developerVideo({
			duration: 120,
			processing: processingState({ probe: null }),
		});

		await prepareDeveloperVideoProcessing("video-1", "encode-1");
		expect(mocks.charge).not.toHaveBeenCalled();
	});

	it("refuses a video longer than the length limit", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 5 * 60 * 60, width: 1920, height: 1080, fps: 30 },
		});
		mocks.store.video = developerVideo({
			duration: 60,
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("4 hour limit");
		expect(mocks.charge).not.toHaveBeenCalled();
	});

	it("fails preparation when the upload has no video track", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 3, width: 0, height: 0, fps: 0 },
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("no video track");
	});

	it("sends the ladder job upload targets under the video's own prefix", async () => {
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-9" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
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
		const hls = video().processing?.hls;
		const token = hls?.state === "running" ? hls.token : "";
		expect(hls).toMatchObject({ state: "running", jobId: "job-9" });
		expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
		for (const [name, url] of Object.entries<string>(body.uploads)) {
			expect(url).toContain(
				`https://storage/put/${ENCODE}/${token}/hls/${name}`,
			);
		}
		expect(body.thumbnailPresignedUrl).toContain(
			`${ENCODE}/${token}/poster.jpg`,
		);
		expect(body.webhookUrl).toBe(
			`https://web.example/api/webhooks/media-server/progress?developerVideo=hls&token=${token}`,
		);
	});

	it("caps the MP4 job at the video's tier", async () => {
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-9" });
		mocks.store.video = developerVideo({
			processing: processingState({
				probe: { duration: 12, width: 3840, height: 2160, fps: 30 },
			}),
		});

		await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4");

		const [path, body] = mocks.startJob.mock.calls[0] ?? [];
		expect(path).toBe("/video/process");
		expect(body).toMatchObject({ maxWidth: 1920, maxHeight: 1920 });
		const mp4 = video().processing?.mp4;
		const token = mp4?.state === "running" ? mp4.token : "";
		expect(body.outputPresignedUrl).toContain(`${ENCODE}/${token}/video.mp4`);
		expect(body.thumbnailPresignedUrl).toContain(
			`${ENCODE}/${token}/poster.jpg`,
		);
	});

	it("parks adaptive streaming when the media server has no ladder endpoint", async () => {
		mocks.startJob.mockResolvedValue({ status: "unavailable" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"unavailable",
		);
		expect(video().processing?.hls).toMatchObject({ state: "unavailable" });
		expect(video().processing?.attempts.hls).toBe(0);
		expect(video().processing?.unavailableChecks).toBe(1);
		expect(video().status).toBe("processing");
	});

	it("gives the attempt back when the media server is busy", async () => {
		mocks.startJob.mockResolvedValue({ status: "busy" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"busy",
		);
		expect(video().processing?.mp4).toEqual({ state: "pending" });
		expect(video().processing?.attempts.mp4).toBe(0);
	});

	it("keeps the part for a later try when the media server cannot be reached", async () => {
		mocks.startJob.mockResolvedValue({ status: "unreachable" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"busy",
		);
		expect(video().processing?.hls).toEqual({ state: "pending" });
		expect(video().processing?.attempts.hls).toBe(0);
		expect(video().status).toBe("processing");
	});

	it("does not start a second job while a start is unconfirmed", async () => {
		mocks.startJob.mockResolvedValue({ status: "unconfirmed" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"unconfirmed",
		);
		expect(video().processing?.hls).toMatchObject({
			state: "running",
			jobId: null,
		});
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			hls: "wait",
			mp4: "dispatch",
		});
		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"skipped",
		);
		expect(mocks.startJob).toHaveBeenCalledTimes(1);
	});

	it("confirms an unconfirmed start from the job's first progress callback", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: {
					state: "running",
					token: "t-hls",
					jobId: null,
					startedAt: 2_000,
				},
			}),
		});

		const result = await applyDeveloperVideoProgress(
			{ videoId: "video-1", jobId: "job-7", phase: "downloading" },
			"hls",
			"t-hls",
		);

		expect(result.applied).toBe(false);
		expect(video().processing?.hls).toMatchObject({
			state: "running",
			token: "t-hls",
			jobId: "job-7",
		});
	});

	it("keeps trying when the media server cannot be reached for the probe", async () => {
		mocks.probe.mockResolvedValue({ status: "unreachable" });
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"retry",
		);
		expect(video().status).toBe("processing");
		expect(video().processing?.probe).toBeNull();
		expect(video().processing?.probing).toBeUndefined();
	});

	it("probes a file once when two callers prepare it at the same time", async () => {
		let finish: (value: unknown) => void = () => undefined;
		mocks.probe.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		const first = prepareDeveloperVideoProcessing("video-1", "encode-1");
		await vi.waitFor(() => expect(mocks.probe).toHaveBeenCalledTimes(1));

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"probing",
		);
		expect(mocks.probe).toHaveBeenCalledTimes(1);

		finish({
			status: "ok",
			metadata: { duration: 12, width: 1920, height: 1080, fps: 30 },
		});

		expect(await first).toBe("ready");
		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);
		expect(mocks.probe).toHaveBeenCalledTimes(1);
		expect(video().processing?.probing).toBeUndefined();
		expect(video().processing?.probe?.width).toBe(1920);
	});

	it("lets the next caller probe after a failed probe gives its claim back", async () => {
		mocks.probe.mockRejectedValueOnce(new Error("connection reset"));
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("connection reset");
		expect(video().processing?.probing).toBeUndefined();

		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1920, height: 1080, fps: 30 },
		});

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);
		expect(mocks.probe).toHaveBeenCalledTimes(2);
	});

	it("takes over a probe claim left by a caller that stopped", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1920, height: 1080, fps: 30 },
		});
		const abandoned = (secondsAgo: number) =>
			developerVideo({
				processing: {
					...processingState({ probe: null }),
					probing: { token: "gone", startedAt: Date.now() - secondsAgo * 1000 },
				},
			});

		mocks.store.video = abandoned(10);
		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"probing",
		);
		expect(mocks.probe).not.toHaveBeenCalled();

		mocks.store.video = abandoned(90);
		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);
		expect(mocks.probe).toHaveBeenCalledTimes(1);
	});

	it("refuses a file the media server cannot read, in words for the customer", async () => {
		mocks.probe.mockResolvedValue({
			status: "rejected",
			message: "Invalid data found when processing input",
			unusable: true,
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		const refusal = prepareDeveloperVideoProcessing("video-1", "encode-1");

		await expect(refusal).rejects.toBeInstanceOf(DeveloperVideoRejected);
		await expect(refusal).rejects.toThrow(
			"This file could not be read as a video. Upload a video file such as MP4, MOV, WebM or MKV.",
		);
		expect(video().processing?.probing).toBeUndefined();
	});

	it.each([
		[
			"Media input rejected: the file is a playlist or resource list, not a media file",
			"This file is a playlist, not a video. Upload the video file itself.",
		],
		["No video stream found", "This file has no video track."],
		["Media input is empty", "The uploaded file is empty. Upload it again."],
		[
			"Media input could not be read",
			"This file could not be read as a video. Upload a video file such as MP4, MOV, WebM or MKV.",
		],
		[
			"Input has an unsupported or unrecognizable format.",
			"This file could not be read as a video. Upload a video file such as MP4, MOV, WebM or MKV.",
		],
		[
			"Video frame is larger than 8K, the largest size this server accepts",
			"This video is larger than 8K. Export it at 8K or smaller and upload that.",
		],
	])(
		"turns the probe error %j into a plain reason",
		async (message, reason) => {
			mocks.probe.mockResolvedValue({
				status: "rejected",
				message,
				unusable: false,
			});
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			await expect(
				prepareDeveloperVideoProcessing("video-1", "encode-1"),
			).rejects.toThrow(reason);
		},
	);

	it.each([
		"Media input is not accessible",
		"Error fetching https://storage.example/secret/path?sig=abc 503 Service Unavailable",
		"Assertion failed.",
	])(
		"does not refuse a video for the probe error %j, which may clear up",
		async (message) => {
			mocks.probe.mockResolvedValue({
				status: "rejected",
				message,
				unusable: false,
			});
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
				"unclear",
			);
			expect(video().status).toBe("processing");
			expect(video().processing?.probing).toBeUndefined();
		},
	);

	it("trusts the media server when it says the file cannot be used", async () => {
		mocks.probe.mockResolvedValue({
			status: "rejected",
			message: "Some new wording",
			unusable: true,
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toBeInstanceOf(DeveloperVideoRejected);
	});

	it("refuses an empty upload without asking the media server", async () => {
		mocks.head.mockResolvedValue({ bytes: 0, contentType: "video/mp4" });
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("The uploaded file is empty. Upload it again.");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a playlist",
			"playlist",
			"This file is a playlist, not a video. Upload the video file itself.",
		],
		[
			"a file that is not media",
			"unknown",
			"This file could not be read as a video. Upload a video file such as MP4, MOV, WebM or MKV.",
		],
	])(
		"refuses %s without asking the media server",
		async (_label, sniffed, reason) => {
			mocks.sniff.mockResolvedValue(sniffed);
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			const refusal = prepareDeveloperVideoProcessing("video-1", "encode-1");

			await expect(refusal).rejects.toBeInstanceOf(DeveloperVideoRejected);
			await expect(refusal).rejects.toThrow(reason);
			expect(mocks.probe).not.toHaveBeenCalled();
			expect(mocks.charge).not.toHaveBeenCalled();
			expect(video().processing?.probing).toBeUndefined();
		},
	);

	it("reads the first bytes of the same file it sends to the media server", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1280, height: 720, fps: 30 },
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await prepareDeveloperVideoProcessing("video-1", "encode-1");

		expect(mocks.sniff).toHaveBeenCalledTimes(1);
		expect(mocks.probe).toHaveBeenCalledTimes(1);
		expect(mocks.sniff.mock.calls[0]?.[0]).toBe(mocks.probe.mock.calls[0]?.[0]);
		expect(mocks.sniff.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.probe.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("leaves the decision to the media server when the first bytes cannot be read", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.sniff.mockRejectedValue(
			new Error("Could not read the stored file (503)"),
		);
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1280, height: 720, fps: 30 },
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).resolves.toBe("ready");
		expect(mocks.probe).toHaveBeenCalledTimes(1);
	});

	it("gives the first read five seconds", async () => {
		mocks.probe.mockResolvedValue({
			status: "ok",
			metadata: { duration: 12, width: 1280, height: 720, fps: 30 },
		});
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await prepareDeveloperVideoProcessing("video-1", "encode-1");

		expect(mocks.sniff).toHaveBeenCalledWith(expect.any(String), 5_000);
	});

	it("renews its claim before the probe when the steps before it were slow", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(1_000_000);
			mocks.sniff.mockImplementation(async () => {
				vi.setSystemTime(1_004_000);
				return "media";
			});
			let claimDuringProbe: number | undefined;
			mocks.probe.mockImplementation(async () => {
				claimDuringProbe = video().processing?.probing?.startedAt;
				return {
					status: "ok",
					metadata: { duration: 12, width: 1280, height: 720, fps: 30 },
				};
			});
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			await expect(
				prepareDeveloperVideoProcessing("video-1", "encode-1"),
			).resolves.toBe("ready");
			expect(claimDuringProbe).toBe(1_004_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the claim time when the steps before the probe were quick", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(1_000_000);
			mocks.sniff.mockImplementation(async () => {
				vi.setSystemTime(1_000_200);
				return "media";
			});
			let claimDuringProbe: number | undefined;
			mocks.probe.mockImplementation(async () => {
				claimDuringProbe = video().processing?.probing?.startedAt;
				return {
					status: "ok",
					metadata: { duration: 12, width: 1280, height: 720, fps: 30 },
				};
			});
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			await prepareDeveloperVideoProcessing("video-1", "encode-1");

			expect(claimDuringProbe).toBe(1_000_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not probe when another caller took the claim over during a slow read", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(1_000_000);
			mocks.sniff.mockImplementation(async () => {
				vi.setSystemTime(1_070_000);
				const current = video();
				current.processing = {
					...current.processing,
					probing: { token: "other-caller", startedAt: 1_069_000 },
				} as typeof current.processing;
				return "media";
			});
			mocks.store.video = developerVideo({
				processing: processingState({ probe: null }),
			});

			await expect(
				prepareDeveloperVideoProcessing("video-1", "encode-1"),
			).resolves.toBe("probing");
			expect(mocks.probe).not.toHaveBeenCalled();
			expect(video().processing?.probing?.token).toBe("other-caller");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not read an empty upload's bytes", async () => {
		mocks.head.mockResolvedValue({ bytes: 0, contentType: "video/mp4" });
		mocks.store.video = developerVideo({
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("The uploaded file is empty. Upload it again.");
		expect(mocks.sniff).not.toHaveBeenCalled();
	});

	it("does not probe again once the video has been failed", async () => {
		mocks.store.video = developerVideo({
			status: "errored",
			processing: processingState({ probe: null }),
		});

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"stale",
		);
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("keeps the media server's wording out of a failed encode's reason", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "failed", reason: "x" },
				mp4: runningPart("t-mp4"),
				attempts: { hls: 2, mp4: 2 },
			}),
		});

		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "error",
				error:
					"ffmpeg exited 1: /tmp/cap-media-server/abc/input.mp4: Invalid data found",
			},
			"mp4",
			"t-mp4",
		);

		expect(video().status).toBe("errored");
		expect(video().errorReason).toBe(
			"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
		);
	});

	it("keeps the media server's wording out of a rejected start's reason", async () => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.startJob.mockResolvedValue({
			status: "rejected",
			message: "Job queue refused /tmp/cap-media-server/abc/input.mp4",
		});
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "failed", reason: "x" },
				attempts: { hls: 2, mp4: 1 },
			}),
		});

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"failed",
		);

		expect(video().status).toBe("errored");
		expect(video().errorReason).toBe(
			"This video could not be processed. Upload it again, or export it as an MP4 and upload that.",
		);
		expect(warnings).toHaveBeenCalledWith(
			"[developer-video] Encode start rejected",
			expect.objectContaining({
				detail: "Job queue refused /tmp/cap-media-server/abc/input.mp4",
			}),
		);
		warnings.mockRestore();
	});

	it("tells the customer when an encode stopped on a frame that is too large", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				hls: { state: "failed", reason: "x" },
				mp4: runningPart("t-mp4"),
				attempts: { hls: 2, mp4: 2 },
			}),
		});

		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "error",
				error:
					"FFmpeg exited with code 234. Last stderr: Picture size 16000x16000 exceeds specified max pixel count 40000000",
			},
			"mp4",
			"t-mp4",
		);

		expect(video().errorReason).toBe(
			"This video is larger than 8K. Export it at 8K or smaller and upload that.",
		);
	});

	it("leaves a restarted video alone when an older run comes back", async () => {
		mocks.startJob.mockResolvedValue({ status: "started", jobId: "job-9" });

		expect(await prepareDeveloperVideoProcessing("video-1", "old-encode")).toBe(
			"stale",
		);
		expect(await readDeveloperVideoParts("video-1", "old-encode")).toBeNull();
		expect(
			await dispatchDeveloperVideoPart("video-1", "old-encode", "hls"),
		).toBe("skipped");
		await failDeveloperVideoProcessing(
			"video-1",
			"old-encode",
			"Video processing timed out",
		);

		expect(mocks.startJob).not.toHaveBeenCalled();
		expect(mocks.store.updates).toHaveLength(0);
		expect(video().status).toBe("processing");
	});

	it("fails preparation for a video that has no uploaded file", async () => {
		mocks.store.video = developerVideo({
			s3Key: null,
			processing: processingState({ probe: null }),
		});

		await expect(
			prepareDeveloperVideoProcessing("video-1", "encode-1"),
		).rejects.toThrow("no uploaded file");
	});

	it("does not dispatch a part twice", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ mp4: runningPart("t-mp4") }),
		});

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "mp4")).toBe(
			"skipped",
		);
		expect(mocks.startJob).not.toHaveBeenCalled();
	});

	it("marks unfinished parts failed when the workflow gives up", async () => {
		await failDeveloperVideoProcessing(
			"video-1",
			"encode-1",
			"Video processing timed out",
		);

		expect(video()).toMatchObject({
			status: "errored",
			errorReason: "Video processing timed out",
		});
	});
});

describe("superseded output sweep", () => {
	it("keeps only the outputs the finished encode settled on", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				hls: { state: "complete", output: "hls-out" },
				mp4: { state: "complete", output: "mp4-out" },
			}),
		});

		await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1");

		const [prefix, keep] = mocks.deleteObjects.mock.calls[0] ?? [];
		expect(prefix).toBe("developer/app-1/video-1/encode-1/");
		expect(keep(`${prefix}hls-out/hls/master.m3u8`)).toBe(true);
		expect(keep(`${prefix}mp4-out/video.mp4`)).toBe(true);
		expect(keep(`${prefix}lost-attempt/hls/1080p.m4s`)).toBe(false);
	});

	it("leaves an encode alone while a part is still running", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({ hls: runningPart("t1") }),
		});

		expect(
			await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1"),
		).toBe(0);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("does nothing for an encode that has been replaced", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				encodeId: "encode-2",
				hls: { state: "complete", output: "hls-out" },
				mp4: { state: "complete", output: "mp4-out" },
			}),
		});

		await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1");
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});
});
