import type {
	DeveloperVideoProcessingState,
	DeveloperVideoSlicedHls,
} from "@cap/database/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";
import {
	slicedHls,
	sliceLadder,
	sliceMaster,
	slicePlaylist,
	sliceResult,
} from "../fixtures/developer-video-slices";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	env: {
		WEB_URL: "https://web.example",
		MEDIA_SERVER_WEBHOOK_URL: undefined,
	} as Record<string, string | undefined>,
	head: vi.fn(),
	readText: vi.fn(),
	writeText: vi.fn(),
	probe: vi.fn(),
	startJob: vi.fn(),
	readJob: vi.fn(),
	charge: vi.fn(),
	deleteObjects: vi.fn(),
	sniff: vi.fn(),
	cancelJob: vi.fn(),
	firstMonth: vi.fn(),
	announce: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const database = await createDeveloperVideoDatabase(mocks.store);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({ serverEnv: () => mocks.env }));
vi.mock("@/lib/developer-video-storage", () => ({
	headDeveloperVideoObject: mocks.head,
	readDeveloperVideoText: mocks.readText,
	writeDeveloperVideoText: mocks.writeText,
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
	cancelMediaServerVideoJob: mocks.cancelJob,
}));
vi.mock("@/lib/media-container", () => ({ sniffMediaUrl: mocks.sniff }));
vi.mock("@/lib/infra-storage-minimum", () => ({
	settleFirstMonthAtReady: mocks.firstMonth,
}));
vi.mock("@/lib/developer-webhook-dispatch", () => ({
	announceDeveloperVideoEvent: mocks.announce,
}));

const {
	applyDeveloperVideoProgress,
	checkDeveloperVideoPart,
	dispatchDeveloperVideoPart,
	dispatchDeveloperVideoParts,
	failDeveloperVideoProcessing,
	prepareDeveloperVideoProcessing,
	readDeveloperVideoParts,
	sweepSupersededDeveloperVideoOutputs,
} = await import("@/lib/developer-video-processing");
const { developerVideoOutputs } = await import("@/lib/developer-video-api");

const FOLDER = "developer/app-1/video-1/encode-1/sliced-1";
// Lengths of the four slices of the 300 second fixture video.
const SECONDS = [20, 96, 96, 88];
// 128 kbps over the 299.9 s of audio the fixture's audio playlist lists.
const AUDIO_BYTES = 4_798_400;

function video() {
	if (!mocks.store.video) throw new Error("no video");
	return mocks.store.video;
}

function state(): DeveloperVideoProcessingState {
	const processing = video().processing;
	if (!processing) throw new Error("no processing state");
	return processing;
}

interface SentSlice {
	index: number;
	token: string;
	body: Record<string, unknown>;
}

const STARTS = [0, 20, 116, 212];

// Every slice job sent so far, read from the encoder requests. Slices sent in
// one pass leave together, so they are listed in playback order.
function sent(): SentSlice[] {
	return sentInOrder().sort((a, b) => a.index - b.index);
}

function sentInOrder(): SentSlice[] {
	return mocks.startJob.mock.calls.flatMap(([path, body]) => {
		const range = (body as { range?: { startSeconds: number } }).range;
		if (path !== "/video/ladder" || !range) return [];
		const token = new URL(
			(body as { webhookUrl: string }).webhookUrl,
		).searchParams.get("token");
		const index = STARTS.indexOf(range.startSeconds);
		return token
			? [{ index, token, body: body as Record<string, unknown> }]
			: [];
	});
}

function latest(index: number): SentSlice {
	const found = sentInOrder()
		.filter((entry) => entry.index === index)
		.at(-1);
	if (!found) throw new Error(`slice ${index} was never sent`);
	return found;
}

const segmentsFor = (seconds: number) =>
	Array.from({ length: seconds / 4 }, () => 4);

function finish(index: number, token = latest(index).token) {
	const seconds = SECONDS[index] ?? 0;
	return applyDeveloperVideoProgress(
		{
			videoId: "video-1",
			phase: "complete",
			ladder: sliceLadder(sliceResult(seconds), index === 0 ? AUDIO_BYTES : 0),
		},
		"hls",
		token,
	);
}

function failSlice(index: number) {
	return applyDeveloperVideoProgress(
		{ videoId: "video-1", phase: "error", error: "ffmpeg exited 1" },
		"hls",
		latest(index).token,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	delete mocks.env.INFRA_SLICED_HLS;
	mocks.store.video = developerVideo({
		duration: 300,
		processing: processingState({
			probe: { duration: 300, width: 1920, height: 1080, fps: 30 },
			sliced: slicedHls(),
		}),
	});
	mocks.store.appDeleted = false;
	mocks.store.updates = [];
	mocks.head.mockImplementation(async (key: string) => {
		if (key.endsWith("/poster.jpg")) {
			return { bytes: 50, contentType: "image/jpeg" };
		}
		if (key.endsWith("/video.mp4")) {
			return { bytes: 2_000, contentType: "video/mp4" };
		}
		return { bytes: 1_000, contentType: "video/quicktime" };
	});
	mocks.readText.mockImplementation(async (key: string) => {
		const file = key.match(/\/slices\/([A-Za-z0-9]+)-(\d)-[^/]+\.m3u8$/);
		if (!file?.[1] || !file[2]) return null;
		if (file[1] === "master") return sliceMaster(["1080p", "360p"]);
		if (file[1] === "audio") {
			return slicePlaylist("audio", [...segmentsFor(296), 3.9]);
		}
		return slicePlaylist(file[1], segmentsFor(SECONDS[Number(file[2])] ?? 4));
	});
	mocks.writeText.mockResolvedValue(undefined);
	mocks.charge.mockResolvedValue("charged");
	mocks.deleteObjects.mockResolvedValue(0);
	mocks.sniff.mockResolvedValue("media");
	mocks.startJob.mockImplementation(async (_path, body) => {
		const range = (body as { range?: { startSeconds: number } }).range;
		return {
			status: "started",
			jobId: range ? `slice-job-${STARTS.indexOf(range.startSeconds)}` : "job",
		};
	});
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("deciding how a video's adaptive stream is encoded", () => {
	const probed = (duration: number) => {
		mocks.store.video = developerVideo({
			duration,
			processing: processingState({ probe: null }),
		});
		mocks.probe.mockResolvedValue({
			status: "probed",
			metadata: { duration, width: 1920, height: 1080, fps: 30 },
		});
	};

	it("plans slices for a video of twenty minutes or more", async () => {
		probed(1266);

		expect(await prepareDeveloperVideoProcessing("video-1", "encode-1")).toBe(
			"ready",
		);

		expect(state().sliced).toMatchObject({
			state: "encoding",
			exposed: null,
			slices: [
				{ startSeconds: 0, durationSeconds: 20, job: { state: "pending" } },
				{ startSeconds: 20, durationSeconds: 120 },
				{ startSeconds: 140, durationSeconds: 376 },
				{ startSeconds: 516, durationSeconds: 376 },
				{ startSeconds: 892, durationSeconds: null },
			],
		});
		expect(state().sliced?.output).toMatch(/^[A-Za-z0-9_-]{16}$/);
		expect(video().status).toBe("processing");
	});

	it("leaves a shorter video on the single job", async () => {
		probed(1199);

		await prepareDeveloperVideoProcessing("video-1", "encode-1");

		expect(state().sliced).toBeUndefined();
	});

	it("leaves every video on the single job when slicing is switched off", async () => {
		mocks.env.INFRA_SLICED_HLS = "off";
		probed(1266);

		await prepareDeveloperVideoProcessing("video-1", "encode-1");

		expect(state().sliced).toBeUndefined();
	});

	it("sends a short video's ladder job exactly as before", async () => {
		mocks.store.video = developerVideo();

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);

		expect(mocks.startJob).toHaveBeenCalledTimes(1);
		const [path, body] = mocks.startJob.mock.calls[0] ?? [];
		const token = state().hls.state === "running" ? state().hls : null;
		if (token?.state !== "running") throw new Error("hls is not running");
		const prefix = `https://storage/put/developer/app-1/video-1/encode-1/${token.token}`;
		expect(path).toBe("/video/ladder");
		expect(body).toEqual({
			videoId: "video-1",
			userId: "app-1",
			videoUrl: "https://storage/developer/app-1/video-1/video",
			thumbnailPresignedUrl: `${prefix}/poster.jpg?type=image/jpeg`,
			webhookUrl: `https://web.example/api/webhooks/media-server/progress?developerVideo=hls&token=${token.token}`,
			inputExtension: ".mov",
			maxTier: "1080p",
			includeAudio: true,
			infra: true,
			uploads: Object.fromEntries(
				[
					["master.m3u8", "application/vnd.apple.mpegurl"],
					...["1080p", "720p", "360p", "audio"].flatMap((name) => [
						[`${name}.m3u8`, "application/vnd.apple.mpegurl"],
						[`${name}.m4s`, "video/mp4"],
					]),
				].map(([name, type]) => [name, `${prefix}/hls/${name}?type=${type}`]),
			),
		});
	});
});

describe("sending slices", () => {
	it("asks the workflow to send them through the hls part", async () => {
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			hls: "dispatch",
			mp4: "dispatch",
		});
	});

	it("sends the first three as their own ladder jobs and never the whole job", async () => {
		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);

		expect(mocks.startJob).toHaveBeenCalledTimes(3);
		expect(sent().map((entry) => entry.body.range)).toEqual([
			{ startSeconds: 0, durationSeconds: 20 },
			{ startSeconds: 20, durationSeconds: 96 },
			{ startSeconds: 116, durationSeconds: 96 },
		]);
		expect(state().hls).toEqual({ state: "pending" });
		expect(state().sliced?.slices.map((entry) => entry.job)).toMatchObject([
			{ state: "running", jobId: "slice-job-0" },
			{ state: "running", jobId: "slice-job-1" },
			{ state: "running", jobId: "slice-job-2" },
			{ state: "pending" },
		]);
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			hls: "wait",
		});
	});

	it("sends the MP4 before any slice when the video starts", async () => {
		let answerMp4: (value: { status: "started"; jobId: string }) => void = () =>
			undefined;
		const startJob = mocks.startJob.getMockImplementation();
		mocks.startJob.mockImplementation(async (path, body) =>
			path === "/video/process"
				? new Promise((resolve) => {
						answerMp4 = resolve;
					})
				: startJob?.(path, body),
		);

		const dispatched = dispatchDeveloperVideoParts("video-1", "encode-1");
		await vi.waitFor(() => expect(mocks.startJob).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.startJob.mock.calls.map(([path]) => path)).toEqual([
			"/video/process",
		]);

		answerMp4({ status: "started", jobId: "mp4-job" });
		const results = await dispatched;
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		expect(mocks.startJob.mock.calls.map(([path]) => path)).toEqual([
			"/video/process",
			"/video/ladder",
			"/video/ladder",
			"/video/ladder",
		]);
		expect(state().mp4).toMatchObject({ state: "running", jobId: "mp4-job" });
	});

	it("gives the first slice the audio and the poster, and the others neither", async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		const first = latest(0);
		const second = latest(1);

		expect(first.body.includeAudio).toBe(true);
		expect(first.body.thumbnailPresignedUrl).toBe(
			`https://storage/put/developer/app-1/video-1/encode-1/${first.token}/poster.jpg?type=image/jpeg`,
		);
		expect(Object.keys(first.body.uploads as object)).toContain("audio.m4s");

		expect(second.body.includeAudio).toBe(false);
		expect(second.body).not.toHaveProperty("thumbnailPresignedUrl");
		expect(Object.keys(second.body.uploads as object)).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"720p.m3u8",
			"720p.m4s",
			"360p.m3u8",
			"360p.m4s",
		]);
	});

	it("stores each slice under its own names in the one sliced folder", async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		const second = latest(1);
		const uploads = second.body.uploads as Record<string, string>;

		expect(uploads["1080p.m4s"]).toBe(
			`https://storage/put/${FOLDER}/hls/1080p-1-${second.token}.m4s?type=video/mp4`,
		);
		expect(uploads["1080p.m3u8"]).toBe(
			`https://storage/put/${FOLDER}/slices/1080p-1-${second.token}.m3u8?type=application/vnd.apple.mpegurl`,
		);
		expect(second.body).toMatchObject({
			videoId: "video-1",
			userId: "app-1",
			videoUrl: "https://storage/developer/app-1/video-1/video",
			maxTier: "1080p",
			webhookUrl: `https://web.example/api/webhooks/media-server/progress?developerVideo=hls&token=${second.token}`,
		});
		expect(new Set(sent().map((entry) => entry.token)).size).toBe(3);
	});

	it("sends the first slice on its own before the others", async () => {
		let answerFirst: (value: { status: "started"; jobId: string }) => void =
			() => undefined;
		mocks.startJob.mockImplementation(async (_path, body) =>
			(body as { range: { startSeconds: number } }).range.startSeconds === 0
				? new Promise((resolve) => {
						answerFirst = resolve;
					})
				: { status: "started", jobId: "job" },
		);

		const dispatched = dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		await vi.waitFor(() => expect(mocks.startJob).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sentInOrder().map((entry) => entry.index)).toEqual([0]);

		answerFirst({ status: "started", jobId: "slice-job-0" });
		expect(await dispatched).toBe("dispatched");
		expect(sentInOrder().map((entry) => entry.index)).toEqual([0, 1, 2]);
	});

	it("asks four workers for the first slice before it waits", async () => {
		mocks.startJob.mockResolvedValue({ status: "busy" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"busy",
		);

		expect(sent().filter((entry) => entry.index === 0)).toHaveLength(4);
		expect(sent().filter((entry) => entry.index === 1)).toHaveLength(2);
		expect(sent().filter((entry) => entry.index === 2)).toHaveLength(2);
		expect(state().sliced?.slices[0]).toMatchObject({
			job: { state: "pending" },
			attempts: 0,
		});
	});

	it("asks again at once when a worker is full, then waits for the next pass", async () => {
		mocks.startJob.mockImplementation(async (_path, body) =>
			(body as { range: { startSeconds: number } }).range.startSeconds === 20
				? { status: "busy" }
				: { status: "started", jobId: "job" },
		);

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);

		expect(sent().filter((entry) => entry.index === 1)).toHaveLength(2);
		expect(state().sliced?.slices[1]).toMatchObject({
			job: { state: "pending" },
			attempts: 0,
		});
		expect(state().sliced?.slices[0]?.job.state).toBe("running");
	});

	it("falls back to the single job when the encoder has no ladder route", async () => {
		mocks.startJob.mockResolvedValue({ status: "unavailable" });

		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");

		expect(state().sliced?.state).toBe("abandoned");
		expect(state().hls).toEqual({ state: "pending" });
		expect(sent().map((entry) => entry.index)).toEqual([0]);
	});

	it("does not start a slice for a video that was deleted", async () => {
		mocks.store.video = { ...video(), deletedAt: new Date() };

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"skipped",
		);
		expect(mocks.startJob).not.toHaveBeenCalled();
	});
});

describe("slice results", () => {
	beforeEach(async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		mocks.store.updates = [];
	});

	it("makes the video ready and playable from the first slice", async () => {
		expect(await finish(0)).toEqual({ success: true, applied: true });

		expect(video().status).toBe("ready");
		expect(developerVideoOutputs(video())).toEqual({
			hls: true,
			mp4: false,
			poster: true,
		});
		expect(state().sliced).toMatchObject({ exposed: true, hasAudio: true });
		expect(state().poster).toEqual({ output: latest(0).token });
		expect(video().storedBytes).toBe(1_000 + 5_700 + AUDIO_BYTES + 50);
		expect(video().renditions).toEqual([
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bitrate: 3_128_000,
				bytes: 5_000,
				codecs: "avc1.640028,mp4a.40.2",
			},
			{
				name: "360p",
				width: 640,
				height: 360,
				bitrate: 528_000,
				bytes: 700,
				codecs: "avc1.64001e,mp4a.40.2",
			},
		]);
	});

	it("sends the next slice as soon as one is in", async () => {
		await finish(0);

		expect(sent().map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
		expect(sentInOrder().at(-1)?.index).toBe(3);
		expect(latest(3).body.range).toEqual({ startSeconds: 212 });
		expect(state().sliced?.slices[3]?.job.state).toBe("running");
	});

	it("applies a result once however often it is delivered", async () => {
		const { token } = latest(0);
		await finish(0, token);
		const stored = video().storedBytes;
		mocks.store.updates = [];

		expect(await finish(0, token)).toEqual({ success: true, applied: false });
		expect(mocks.store.updates).toHaveLength(0);
		expect(video().storedBytes).toBe(stored);
	});

	it("keeps the video processing while only later slices are in", async () => {
		await finish(2);
		await finish(1);

		expect(video().status).toBe("processing");
		expect(developerVideoOutputs(video()).hls).toBe(false);
		expect(video().renditions).toBeNull();
		expect(video().storedBytes).toBe(1_000 + 5_700 * 2);

		await finish(0);

		expect(video().status).toBe("ready");
		expect(video().renditions?.[0]?.bytes).toBe(15_000);
	});

	it("keeps both results when two slices finish at the same moment", async () => {
		const results = await Promise.all([finish(1), finish(2), finish(0)]);

		expect(results.every((result) => result.applied)).toBe(true);
		expect(state().sliced?.slices.map((entry) => entry.job.state)).toEqual([
			"complete",
			"complete",
			"complete",
			"running",
		]);
		expect(video().storedBytes).toBe(1_000 + 5_700 * 3 + AUDIO_BYTES + 50);
		expect(sent().filter((entry) => entry.index === 3)).toHaveLength(1);
	});

	it("records the job id a progress report carries", async () => {
		mocks.startJob.mockResolvedValue({ status: "unconfirmed" });
		mocks.store.video = developerVideo({
			processing: processingState({ sliced: slicedHls() }),
		});
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		const first = latest(0);

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "processing", jobId: "job-late" },
			"hls",
			first.token,
		);

		expect(state().sliced?.slices[0]?.job).toMatchObject({
			jobId: "job-late",
		});
	});

	it("refuses a slice that does not cover its part of the video", async () => {
		mocks.readText.mockImplementation(async (key: string) =>
			key.includes("/master-")
				? sliceMaster(["1080p", "360p"])
				: slicePlaylist(key.includes("360p") ? "360p" : "1080p", [4, 4]),
		);

		await finish(1);

		expect(state().sliced?.slices[1]).toMatchObject({
			job: { state: "running" },
			attempts: 2,
		});
		expect(state().sliced?.slices[1]?.result).toBeUndefined();
		expect(sent().filter((entry) => entry.index === 1)).toHaveLength(2);
	});

	it("refuses a slice whose playlists were not stored", async () => {
		mocks.readText.mockResolvedValue(null);

		await finish(0);

		expect(state().sliced?.slices[0]?.result).toBeUndefined();
		expect(video().status).toBe("processing");
	});

	it("ignores a result for a video that was deleted mid-encode", async () => {
		mocks.store.video = { ...video(), deletedAt: new Date() };

		expect(await finish(0)).toEqual({ success: true, applied: false });
		expect(mocks.store.updates).toHaveLength(0);
		expect(sent()).toHaveLength(3);
	});
});

describe("copied audio", () => {
	it("lists audio copied from the source at its own rate", async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "complete",
				ladder: sliceLadder(sliceResult(SECONDS[0] ?? 20), 5_998_000),
			},
			"hls",
			latest(0).token,
		);
		await finish(1);
		await finish(2);
		await finish(3);
		const written = Object.fromEntries(
			mocks.writeText.mock.calls.map(([key, text]) => [
				(key as string).split("/").at(-1),
				text as string,
			]),
		);

		expect(state().sliced?.slices[0]?.result?.audioBitrate).toBe(160_000);
		expect(written["master.m3u8"]).toContain(
			"BANDWIDTH=4192000,AVERAGE-BANDWIDTH=3160000,",
		);
		expect(video().renditions?.map((rendition) => rendition.bitrate)).toEqual([
			3_160_000, 560_000,
		]);
	});
});

describe("the last slice", () => {
	beforeEach(async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		await finish(0);
		await finish(1);
		await finish(2);
	});

	it("writes the whole ladder into the sliced folder and completes the hls part", async () => {
		expect(mocks.writeText).not.toHaveBeenCalled();

		await finish(3);

		expect(
			mocks.writeText.mock.calls.map(([key, , type]) => [key, type]).sort(),
		).toEqual(
			["1080p.m3u8", "360p.m3u8", "audio.m3u8", "master.m3u8"].map((file) => [
				`${FOLDER}/hls/${file}`,
				"application/vnd.apple.mpegurl",
			]),
		);
		expect(state().hls).toEqual({ state: "complete", output: "sliced-1" });
		expect(state().sliced?.state).toBe("complete");
		expect(video().status).toBe("ready");
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			hls: "done",
		});
	});

	it("stores playlists that list every slice's media in order and end", async () => {
		await finish(3);
		const written = Object.fromEntries(
			mocks.writeText.mock.calls.map(([key, text]) => [
				(key as string).split("/").at(-1),
				text as string,
			]),
		);
		const tokens = [0, 1, 2, 3].map((index) => latest(index).token);

		expect(written["1080p.m3u8"]?.match(/#EXT-X-MAP:URI="([^"]+)"/g)).toEqual(
			tokens.map(
				(token, index) => `#EXT-X-MAP:URI="1080p-${index}-${token}.m4s"`,
			),
		);
		expect(written["1080p.m3u8"]?.match(/#EXTINF/g)).toHaveLength(75);
		expect(written["1080p.m3u8"]?.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
		expect(written["audio.m3u8"]).toContain(`audio-0-${tokens[0]}.m4s`);
		expect(written["audio.m3u8"]?.match(/#EXTINF/g)).toHaveLength(75);
		expect(written["master.m3u8"]).toContain(
			'#EXT-X-STREAM-INF:BANDWIDTH=4192000,AVERAGE-BANDWIDTH=3128000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"\n1080p.m3u8',
		);
	});

	it("accounts for every slice once, the audio once and one poster", async () => {
		await finish(3);

		expect(video().storedBytes).toBe(1_000 + 5_700 * 4 + AUDIO_BYTES + 50);
		expect(state().bytes).toEqual({
			source: 1_000,
			hls: 5_700 * 4 + AUDIO_BYTES,
			mp4: 0,
			poster: 50,
		});
		expect(video().renditions).toEqual([
			{
				name: "1080p",
				width: 1920,
				height: 1080,
				bitrate: 3_128_000,
				bytes: 20_000,
				codecs: "avc1.640028,mp4a.40.2",
			},
			{
				name: "360p",
				width: 640,
				height: 360,
				bitrate: 528_000,
				bytes: 2_800,
				codecs: "avc1.64001e,mp4a.40.2",
			},
		]);
	});

	it("is retried by the workflow when the ladder could not be written", async () => {
		mocks.writeText.mockRejectedValueOnce(new Error("storage is down"));

		await finish(3);

		expect(state().hls).toEqual({ state: "pending" });
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			hls: "dispatch",
		});

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);
		expect(state().hls).toEqual({ state: "complete", output: "sliced-1" });
		expect(sent()).toHaveLength(4);
	});

	it("keeps the ladder, each slice's media, the poster and nothing else", async () => {
		await finish(3);
		const tokens = [0, 1, 2, 3].map((index) => latest(index).token);
		expect(
			await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1"),
		).toBe(0);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		mocks.store.video = {
			...video(),
			processing: { ...state(), mp4: { state: "complete", output: "mp4-1" } },
		};

		await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1");

		const [prefix, keep] = mocks.deleteObjects.mock.calls[0] ?? [];
		expect(prefix).toBe("developer/app-1/video-1/encode-1/");
		const kept = (key: string) => (keep as (key: string) => boolean)(key);
		expect(kept(`${FOLDER}/hls/master.m3u8`)).toBe(true);
		expect(kept(`${FOLDER}/hls/1080p.m3u8`)).toBe(true);
		expect(kept(`${FOLDER}/hls/audio.m3u8`)).toBe(true);
		expect(kept(`${FOLDER}/hls/1080p-2-${tokens[2]}.m4s`)).toBe(true);
		expect(kept(`${FOLDER}/hls/audio-0-${tokens[0]}.m4s`)).toBe(true);
		expect(
			kept(`developer/app-1/video-1/encode-1/${tokens[0]}/poster.jpg`),
		).toBe(true);
		expect(kept(`${FOLDER}/hls/1080p-2-someOtherAttempt.m4s`)).toBe(false);
		expect(kept(`${FOLDER}/hls/720p-2-${tokens[2]}.m4s`)).toBe(false);
		expect(kept(`${FOLDER}/slices/1080p-2-${tokens[2]}.m3u8`)).toBe(false);
		expect(kept("developer/app-1/video-1/encode-1/mp4-1/video.mp4")).toBe(true);
	});
});

describe("a lost slice", () => {
	const START = new Date("2026-11-01T00:00:00Z").getTime();

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
	});

	it("is asked about after three quiet minutes and left alone while it runs", async () => {
		mocks.readJob.mockResolvedValue({ status: "running" });
		vi.setSystemTime(START + 3 * 60_000);

		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			hls: "check",
		});
		expect(await checkDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"waiting",
		);

		expect(mocks.readJob).toHaveBeenCalledTimes(3);
		expect(state().sliced?.slices[0]?.job).toMatchObject({
			state: "running",
			checkedAt: START + 3 * 60_000,
		});
		expect(sent()).toHaveLength(3);
	});

	it("is sent again once the encoder has not known its job for a minute", async () => {
		mocks.readJob.mockImplementation(async (jobId: string) =>
			jobId === "slice-job-1" ? { status: "missing" } : { status: "running" },
		);
		vi.setSystemTime(START + 3 * 60_000);
		await checkDeveloperVideoPart("video-1", "encode-1", "hls");
		expect(state().sliced?.slices[1]?.job).toMatchObject({
			state: "running",
			notFoundAt: START + 3 * 60_000,
		});

		vi.setSystemTime(START + 6 * 60_000 + 1_000);
		await checkDeveloperVideoPart("video-1", "encode-1", "hls");

		expect(state().sliced?.slices[1]).toMatchObject({
			job: { state: "pending" },
			attempts: 0,
			lostJobs: 1,
		});
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		expect(sent().filter((entry) => entry.index === 1)).toHaveLength(2);
		expect(state().sliced?.state).toBe("encoding");
	});

	it("takes the result from the encoder when the webhook never arrived", async () => {
		mocks.readJob.mockImplementation(async (jobId: string) =>
			jobId === "slice-job-0"
				? {
						status: "finished",
						progress: {
							videoId: "video-1",
							phase: "complete",
							ladder: sliceLadder(sliceResult(20), AUDIO_BYTES),
						},
					}
				: { status: "running" },
		);
		vi.setSystemTime(START + 3 * 60_000);

		await checkDeveloperVideoPart("video-1", "encode-1", "hls");

		expect(state().sliced?.slices[0]?.job.state).toBe("complete");
		expect(video().status).toBe("ready");
	});

	it("is sent again without an attempt when its server shut down", async () => {
		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "cancelled",
				message: "Server shutting down",
			},
			"hls",
			latest(2).token,
		);

		expect(state().sliced?.slices[2]).toMatchObject({
			job: { state: "running" },
			attempts: 1,
			lostJobs: 1,
		});
		expect(sent().filter((entry) => entry.index === 2)).toHaveLength(2);
	});
});

describe("a slice that fails twice", () => {
	beforeEach(async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		await finish(0);
	});

	it("is sent a second time after its first failure", async () => {
		await failSlice(1);

		expect(sent().filter((entry) => entry.index === 1)).toHaveLength(2);
		expect(state().sliced?.state).toBe("encoding");
		expect(video().status).toBe("ready");
	});

	it("falls back to today's single job, which runs once", async () => {
		await failSlice(1);
		await failSlice(1);

		expect(state().sliced?.state).toBe("abandoned");
		expect(video().status).toBe("ready");
		expect(developerVideoOutputs(video()).hls).toBe(true);
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toMatchObject({
			hls: "dispatch",
		});
		const before = mocks.startJob.mock.calls.length;

		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");

		const [path, body] = mocks.startJob.mock.calls[before] ?? [];
		expect(path).toBe("/video/ladder");
		expect(body).not.toHaveProperty("range");
		expect(body).toMatchObject({ includeAudio: true, maxTier: "1080p" });
		expect(state().hls).toMatchObject({ state: "running" });
		expect(state().attempts.hls).toBe(2);
	});

	it("drops late results from the slices that were still running", async () => {
		await failSlice(1);
		await failSlice(1);
		mocks.store.updates = [];

		expect(await finish(2)).toEqual({ success: true, applied: false });
		expect(mocks.store.updates).toHaveLength(0);
	});

	const fallBackAndFail = async () => {
		await failSlice(1);
		await failSlice(1);
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		const hls = state().hls;
		if (hls.state !== "running") throw new Error("single job is not running");
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "ffmpeg exited 1" },
			"hls",
			hls.token,
		);
	};

	it("ends errored when the single job fails too and there is no MP4", async () => {
		mocks.store.video = {
			...video(),
			processing: { ...state(), mp4: { state: "failed", reason: "no mp4" } },
		};

		await fallBackAndFail();

		expect(state().hls.state).toBe("failed");
		expect(video().status).toBe("errored");
		expect(video().errorReason).toBe("no mp4");
		expect(video().renditions).toBeNull();
		expect(developerVideoOutputs(video()).hls).toBe(false);
		expect(video().storedBytes).toBe(1_000 + 50);
	});

	it("plays from the MP4 with no adaptive stream when the single job fails too", async () => {
		mocks.store.video = {
			...video(),
			processing: {
				...state(),
				mp4: { state: "complete", output: "mp4-1" },
				bytes: { ...state().bytes, mp4: 2_000 },
			},
		};

		await fallBackAndFail();

		expect(video().status).toBe("ready");
		expect(developerVideoOutputs(video())).toEqual({
			hls: false,
			mp4: true,
			poster: true,
		});
		expect(video().renditions).toBeNull();
	});

	it("keeps the media viewers were shown once the single job has finished", async () => {
		await failSlice(1);
		await failSlice(1);
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		const hls = state().hls;
		if (hls.state !== "running") throw new Error("single job is not running");
		mocks.readText.mockResolvedValue(
			[
				"#EXTM3U",
				"#EXT-X-STREAM-INF:BANDWIDTH=4000000",
				"1080p.m3u8",
				"#EXT-X-STREAM-INF:BANDWIDTH=500000",
				"360p.m3u8",
			].join("\n"),
		);
		await applyDeveloperVideoProgress(
			{
				videoId: "video-1",
				phase: "complete",
				ladder: sliceLadder(sliceResult(300), AUDIO_BYTES),
			},
			"hls",
			hls.token,
		);
		expect(state().hls).toEqual({ state: "complete", output: hls.token });
		expect(video().storedBytes).toBe(1_000 + 5_700 + AUDIO_BYTES + 50 * 2);
		mocks.store.video = {
			...video(),
			processing: { ...state(), mp4: { state: "failed", reason: "x" } },
		};

		await sweepSupersededDeveloperVideoOutputs("video-1", "encode-1");

		const keep = mocks.deleteObjects.mock.calls[0]?.[1] as (
			key: string,
		) => boolean;
		expect(keep(`${FOLDER}/hls/1080p-0-${latest(0).token}.m4s`)).toBe(true);
		expect(keep(`${FOLDER}/hls/audio-0-${latest(0).token}.m4s`)).toBe(true);
		expect(keep(`${FOLDER}/slices/1080p-0-${latest(0).token}.m3u8`)).toBe(true);
		expect(keep(`${FOLDER}/slices/audio-0-${latest(0).token}.m3u8`)).toBe(true);
		expect(keep(`${FOLDER}/slices/master-0-${latest(0).token}.m3u8`)).toBe(
			false,
		);
		expect(
			keep(`developer/app-1/video-1/encode-1/${hls.token}/hls/1080p.m4s`),
		).toBe(true);
	});

	it("stops the slice jobs still running when the slices are given up", async () => {
		await failSlice(1);
		await failSlice(1);

		expect(state().sliced?.state).toBe("abandoned");
		expect(mocks.cancelJob.mock.calls.map(([jobId]) => jobId).sort()).toEqual([
			"slice-job-2",
			"slice-job-3",
		]);
	});

	it("ends errored when the workflow runs out of time before anything else finished", async () => {
		mocks.store.video = {
			...video(),
			processing: { ...state(), mp4: { state: "failed", reason: "no mp4" } },
		};

		await failDeveloperVideoProcessing(
			"video-1",
			"encode-1",
			"Processing took too long and was stopped. Upload the video again.",
		);

		expect(state().sliced?.state).toBe("abandoned");
		expect(video().status).toBe("errored");
		expect(video().renditions).toBeNull();
	});
});

describe("slices alongside the rest of Infra processing", () => {
	const announced = () =>
		mocks.announce.mock.calls
			.map(([, step]) => (step as { type: string | null }).type)
			.filter((type) => type !== null);

	it("marks every slice job, and the single job it falls back to, as Infra", async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		expect(sent()).toHaveLength(3);
		for (const entry of sent()) expect(entry.body.infra).toBe(true);

		await failSlice(1);
		await failSlice(1);
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");

		const [path, body] = mocks.startJob.mock.calls.at(-1) ?? [];
		expect(path).toBe("/video/ladder");
		expect(body).not.toHaveProperty("range");
		expect((body as { infra?: boolean }).infra).toBe(true);
	});

	it("stamps the encode busy when a slice finds every worker full", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		mocks.startJob.mockResolvedValue({ status: "busy" });

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"busy",
		);

		expect(state().busyAt).toBe(1_000_000);
		expect(
			state().sliced?.slices.every((slice) => slice.job.state === "pending"),
		).toBe(true);
	});

	it("is not reported busy while other slices of the video are encoding", async () => {
		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");
		mocks.startJob.mockResolvedValue({ status: "busy" });
		await finish(0);
		expect(state().sliced?.slices.map((slice) => slice.job.state)).toEqual([
			"complete",
			"running",
			"running",
			"pending",
		]);

		expect(await dispatchDeveloperVideoPart("video-1", "encode-1", "hls")).toBe(
			"dispatched",
		);
		expect(state().sliced?.slices[3]?.job.state).toBe("pending");
	});

	it("starts the MP4 and the slices on the first pass, never a single HLS job", async () => {
		const results = await dispatchDeveloperVideoParts("video-1", "encode-1");

		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		const paths = mocks.startJob.mock.calls.map(([path, body]) => [
			path,
			(body as { range?: unknown }).range !== undefined,
		]);
		expect(paths.filter(([path]) => path === "/video/process")).toHaveLength(1);
		expect(
			paths.filter(([path, ranged]) => path === "/video/ladder" && !ranged),
		).toHaveLength(0);
		expect(sent()).toHaveLength(3);
		expect(state().hls).toEqual({ state: "pending" });
		expect(state().mp4.state).toBe("running");
	});

	it("cancels a slice job whose start lands after the slices were given up", async () => {
		mocks.startJob.mockImplementation(async (_path, body) => {
			const range = (body as { range?: { startSeconds: number } }).range;
			if (range?.startSeconds === 20) {
				mocks.store.video = {
					...video(),
					processing: {
						...state(),
						sliced: {
							...(state().sliced as DeveloperVideoSlicedHls),
							state: "abandoned",
							reason: "x",
						},
					},
				};
			}
			return {
				status: "started",
				jobId: `slice-job-${STARTS.indexOf(range?.startSeconds ?? -1)}`,
			};
		});
		mocks.cancelJob.mockResolvedValue("cancelled");

		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");

		expect(mocks.cancelJob).toHaveBeenCalledWith("slice-job-1");
		expect(mocks.cancelJob).not.toHaveBeenCalledWith("slice-job-0");
	});

	it("cancels a slice job whose start lands after the video was deleted", async () => {
		mocks.startJob.mockImplementation(async (_path, body) => {
			const range = (body as { range?: { startSeconds: number } }).range;
			if (range?.startSeconds === 20) {
				mocks.store.video = { ...video(), deletedAt: new Date() };
			}
			return {
				status: "started",
				jobId: `slice-job-${STARTS.indexOf(range?.startSeconds ?? -1)}`,
			};
		});
		mocks.cancelJob.mockResolvedValue("cancelled");

		await dispatchDeveloperVideoPart("video-1", "encode-1", "hls");

		expect(mocks.cancelJob).toHaveBeenCalledWith("slice-job-1");
	});

	it("becomes ready, settles the first month and sends video.ready exactly once", async () => {
		await dispatchDeveloperVideoParts("video-1", "encode-1");
		const mp4 = state().mp4;
		if (mp4.state !== "running") throw new Error("mp4 is not running");

		await finish(0);

		expect(video().status).toBe("ready");
		expect(mocks.firstMonth).toHaveBeenCalledTimes(1);
		expect(announced()).toEqual([]);
		expect(state().readyEventDueAt).toEqual(expect.any(Number));

		await finish(1);
		await finish(2);
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "complete" },
			"mp4",
			mp4.token,
		);
		expect(state().mp4.state).toBe("complete");
		expect(announced()).toEqual([]);

		await finish(3);

		expect(state().hls).toEqual({ state: "complete", output: "sliced-1" });
		expect(announced()).toEqual(["video.ready"]);
		expect(state().readyEventDueAt).toBeUndefined();
		expect(mocks.firstMonth).toHaveBeenCalledTimes(1);

		await finish(3, latest(3).token);
		await readDeveloperVideoParts("video-1", "encode-1");
		expect(announced()).toEqual(["video.ready"]);
		expect(mocks.firstMonth).toHaveBeenCalledTimes(1);
	});
});
