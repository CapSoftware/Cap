import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

type Endpoint = {
	id: string;
	appId: string;
	events: string[];
	enabled: boolean;
	deletedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	endpoints: [] as Endpoint[],
	endpointQueries: 0,
	failEndpointQuery: false,
	hangEndpointQuery: false,
	failTransactions: 0,
	start: vi.fn(),
	attempt: vi.fn(),
	sleep: vi.fn(),
	head: vi.fn(),
	readText: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const schema = await import("@cap/database/schema");
	const videos = await createDeveloperVideoDatabase(mocks.store);
	const endpointRows = async () => {
		mocks.endpointQueries += 1;
		if (mocks.hangEndpointQuery) await new Promise<never>(() => {});
		if (mocks.failEndpointQuery) throw new Error("database is away");
		const appId = mocks.store.video?.appId;
		return mocks.endpoints.filter(
			(endpoint) =>
				endpoint.appId === appId && endpoint.enabled && !endpoint.deletedAt,
		);
	};
	// The real row lock makes two writers to one video take turns. The video
	// fake has no lock, so transactions are queued here to stand in for it.
	let turn: Promise<unknown> = Promise.resolve();
	const database = {
		...videos,
		select: (fields?: Record<string, unknown>) => ({
			from: (table: object) =>
				table === schema.developerWebhookEndpoints
					? { where: endpointRows }
					: videos.select(fields).from(),
		}),
		transaction: (run: (tx: unknown) => Promise<unknown>) => {
			const next = turn.then(() => {
				if (mocks.failTransactions > 0) {
					mocks.failTransactions -= 1;
					throw new Error("connection lost");
				}
				return run(database);
			});
			turn = next.catch(() => undefined);
			return next;
		},
	};
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	NODE_ENV: "test",
	serverEnv: () => ({
		WEB_URL: "https://web.example",
		INFRA_PLAYBACK_URL: "https://play.example",
		MEDIA_SERVER_WEBHOOK_URL: undefined,
	}),
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/deliver-developer-webhook", () => ({
	deliverDeveloperWebhookWorkflow: "deliver-developer-webhook",
}));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/lib/developer-webhook-delivery", () => ({
	deliverDeveloperWebhookAttempt: mocks.attempt,
}));
vi.mock("@/lib/developer-video-storage", () => ({
	headDeveloperVideoObject: mocks.head,
	readDeveloperVideoText: mocks.readText,
	deleteDeveloperVideoObjects: vi.fn(),
	developerVideoPrefix: (video: { appId: string; id: string }) =>
		`developer/${video.appId}/${video.id}/`,
	internalDeveloperVideoUrl: async (key: string) => `https://storage/${key}`,
	developerVideoUploadUrl: async (key: string) => `https://storage/put/${key}`,
}));
vi.mock("@/lib/developer-video-charge", () => ({
	DEVELOPER_VIDEO_MAX_DURATION_SECONDS: 4 * 60 * 60,
	chargeDeveloperVideoUpload: vi.fn(async () => "charged"),
}));
vi.mock("@/lib/media-client", () => ({
	MEDIA_SERVER_SHUTDOWN_MESSAGE: "Server shutting down",
	tryProbeVideoViaMediaServer: vi.fn(),
	startMediaServerVideoJob: vi.fn(),
	readMediaServerVideoJob: vi.fn(),
}));
vi.mock("@/lib/media-container", () => ({ sniffMediaUrl: vi.fn() }));

const {
	applyDeveloperVideoProgress,
	claimDeveloperVideoProcessing,
	failDeveloperVideoProcessing,
	readDeveloperVideoParts,
} = await import("@/lib/developer-video-processing");
const { developerVideoEventStep, READY_EVENT_MAX_WAIT_MS } = await import(
	"@/lib/developer-webhook-events"
);
const { deliverDeveloperWebhookWorkflow } = await vi.importActual<
	typeof import("@/workflows/deliver-developer-webhook")
>("@/workflows/deliver-developer-webhook");
const { enqueueDeveloperVideoEvent } = await import(
	"@/lib/developer-webhook-dispatch"
);
const { developerVideoEventId } = await import(
	"@/lib/developer-webhook-signature"
);
const { serializeDeveloperVideo } = await import("@/lib/developer-video-api");

const running = (token: string) => ({
	state: "running" as const,
	token,
	jobId: `job-${token}`,
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
	],
	audio: { bytes: 300 },
};
const master = [
	"#EXTM3U",
	"#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080",
	"1080p.m3u8",
].join("\n");

const mp4Done = () =>
	applyDeveloperVideoProgress(
		{ videoId: "video-1", phase: "complete" },
		"mp4",
		"m1",
	);
const hlsDone = () =>
	applyDeveloperVideoProgress(
		{ videoId: "video-1", phase: "complete", ladder },
		"hls",
		"h1",
	);

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function readyData() {
	const job = jobs().find((queued) => queued.eventType === "video.ready");
	return JSON.parse(job?.body ?? "{}").data;
}

function video() {
	if (!mocks.store.video) throw new Error("no video");
	return mocks.store.video;
}

const jobs = () =>
	mocks.start.mock.calls.map(
		([, [job]]) =>
			job as {
				endpointId: string;
				eventId: string;
				eventType: string;
				body: string;
			},
	);

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.clearAllMocks();
	mocks.store.video = developerVideo({
		processing: processingState({ mp4: running("m1"), hls: running("h1") }),
	});
	mocks.store.updates = [];
	mocks.endpoints = [
		{
			id: "wh-1",
			appId: "app-1",
			events: ["video.ready", "video.errored"],
			enabled: true,
			deletedAt: null,
		},
	];
	mocks.endpointQueries = 0;
	mocks.failEndpointQuery = false;
	mocks.hangEndpointQuery = false;
	mocks.failTransactions = 0;
	mocks.start.mockResolvedValue({ runId: "run-1" });
	mocks.sleep.mockResolvedValue(undefined);
	mocks.head.mockResolvedValue({ bytes: 2_000, contentType: "video/mp4" });
	mocks.readText.mockResolvedValue(master);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("video.ready", () => {
	it("queues one delivery carrying the video as GET /videos/:id returns it", async () => {
		await mp4Done();
		await hlsDone();
		await settled();

		expect(video().status).toBe("ready");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		const [job] = jobs();
		expect(job).toMatchObject({
			endpointId: "wh-1",
			eventType: "video.ready",
			eventId: developerVideoEventId("video-1", "video.ready"),
		});
		const event = JSON.parse(job?.body ?? "{}");
		expect(event).toMatchObject({
			id: job?.eventId,
			type: "video.ready",
		});
		expect(Number.isNaN(Date.parse(event.createdAt))).toBe(false);
		expect(event.data).toEqual(
			JSON.parse(JSON.stringify(serializeDeveloperVideo(video()))),
		);
		expect(event.data).toMatchObject({ id: "video-1", status: "ready" });
		expect(event.data.mp4Url).toContain("https://play.example/");
		expect(event.data.hlsUrl).toContain("https://play.example/");
		expect(job?.body).not.toContain("s3Key");
		expect(job?.body).not.toContain("developer/app-1");
	});

	it("waits for HLS when the MP4 makes the video ready first", async () => {
		await mp4Done();
		await settled();
		expect(video().status).toBe("ready");
		expect(video().processing?.readyEventDueAt).toEqual(expect.any(Number));
		expect(mocks.start).not.toHaveBeenCalled();

		await hlsDone();
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(readyData()).toMatchObject({
			hlsUrl: expect.stringContaining("/master.m3u8"),
			mp4Url: expect.stringContaining("https://play.example/"),
		});
		expect(video().processing?.readyEventDueAt).toBeUndefined();
	});

	it("waits for the MP4 when HLS makes the video ready first", async () => {
		await hlsDone();
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.start).not.toHaveBeenCalled();

		await mp4Done();
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(readyData()).toMatchObject({
			hlsUrl: expect.stringContaining("/master.m3u8"),
			mp4Url: expect.stringContaining("https://play.example/"),
		});
	});

	it("queues one event carrying both URLs when both outputs finish at once", async () => {
		await Promise.all([mp4Done(), hlsDone()]);
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(jobs()[0]?.eventType).toBe("video.ready");
		expect(readyData().hlsUrl).toContain("/master.m3u8");
		expect(readyData().mp4Url).toContain("https://play.example/");
	});

	it("queues one event when both outputs settle in one update", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: { state: "complete", output: "m0" },
				hls: running("h1"),
			}),
		});
		await hlsDone();
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(video().processing?.readyEventDueAt).toBeUndefined();
	});

	it("queues nothing more when the encoder's callbacks arrive again", async () => {
		await mp4Done();
		await mp4Done();
		await hlsDone();
		await hlsDone();
		await mp4Done();
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("is sent with hlsUrl null when HLS fails", async () => {
		mocks.store.video = developerVideo({
			processing: processingState({
				mp4: running("m1"),
				hls: running("h1"),
				attempts: { hls: 2, mp4: 1 },
			}),
		});
		await mp4Done();
		await settled();
		expect(mocks.start).not.toHaveBeenCalled();

		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "boom" },
			"hls",
			"h1",
		);
		await settled();
		expect(video().processing?.hls.state).toBe("failed");
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
		expect(readyData()).toMatchObject({
			hlsUrl: null,
			mp4Url: expect.stringContaining("https://play.example/"),
		});
	});

	it("is sent once, with hlsUrl null, when HLS never settles", async () => {
		const realNow = Date.now();
		vi.setSystemTime(realNow);
		await mp4Done();
		await settled();
		expect(mocks.start).not.toHaveBeenCalled();

		vi.setSystemTime(realNow + READY_EVENT_MAX_WAIT_MS - 1_000);
		await readDeveloperVideoParts("video-1", "encode-1");
		await settled();
		expect(mocks.start).not.toHaveBeenCalled();

		vi.setSystemTime(realNow + READY_EVENT_MAX_WAIT_MS);
		const parts = await readDeveloperVideoParts("video-1", "encode-1");
		await settled();
		expect(parts?.hls).toBe("check");
		expect(video().processing?.hls.state).toBe("running");
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
		expect(readyData()).toMatchObject({
			hlsUrl: null,
			mp4Url: expect.stringContaining("https://play.example/"),
		});

		await readDeveloperVideoParts("video-1", "encode-1");
		await hlsDone();
		await settled();
		expect(video().processing?.hls.state).toBe("complete");
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("is sent with hlsUrl null when processing times out on a stuck HLS job", async () => {
		await mp4Done();
		await settled();
		await failDeveloperVideoProcessing("video-1", "encode-1", "Too long");
		await settled();
		expect(video().status).toBe("ready");
		expect(video().processing?.hls.state).toBe("failed");
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
		expect(readyData().hlsUrl).toBeNull();
	});

	it("is sent on the next poll when the last output was settled without sending", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "m1" },
				hls: { state: "complete", output: "h1" },
				readyEventDueAt: Date.now() - 5_000,
			}),
		});
		const parts = await readDeveloperVideoParts("video-1", "encode-1");
		await readDeveloperVideoParts("video-1", "encode-1");
		await settled();
		expect(parts).toEqual({ hls: "done", mp4: "done" });
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
		expect(readyData().hlsUrl).toContain("/master.m3u8");
		expect(video().processing?.readyEventDueAt).toBeUndefined();
	});

	it("keeps the workflow polling when sending a due event fails", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "m1" },
				hls: { state: "complete", output: "h1" },
				readyEventDueAt: Date.now() - 5_000,
			}),
		});
		mocks.failTransactions = 1;
		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			hls: "wait",
			mp4: "wait",
		});
		await settled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(video().processing?.readyEventDueAt).toEqual(expect.any(Number));

		expect(await readDeveloperVideoParts("video-1", "encode-1")).toEqual({
			hls: "done",
			mp4: "done",
		});
		await settled();
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
	});

	it("sends no second event for a video that was ready before this change", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "m0" },
				hls: running("h1"),
			}),
		});
		await hlsDone();
		await settled();
		expect(video().processing?.hls.state).toBe("complete");

		vi.setSystemTime(Date.now() + 2 * READY_EVENT_MAX_WAIT_MS);
		await readDeveloperVideoParts("video-1", "encode-1");
		await settled();
		expect(mocks.endpointQueries).toBe(0);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("sends no event for a video that was ready before webhooks existed", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			createdAt: new Date("2026-10-01T00:00:00Z"),
			updatedAt: new Date("2026-10-01T00:00:00Z"),
			processing: processingState({
				mp4: { state: "complete", output: "m0" },
				hls: { state: "unavailable", reason: "not yet", retryAt: 0 },
			}),
		});
		expect(await claimDeveloperVideoProcessing("video-1")).toMatchObject({
			action: "retry-hls",
		});
		expect(video().processing?.hls.state).toBe("pending");
		mocks.store.video = {
			...video(),
			processing: processingState({
				...video().processing,
				hls: running("h1"),
			}),
		};
		await hlsDone();
		await settled();
		expect(video().processing?.hls.state).toBe("complete");
		expect(mocks.endpointQueries).toBe(0);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("re-sends the same event id and body on every retry", async () => {
		await mp4Done();
		await hlsDone();
		await settled();
		const [job] = jobs();
		if (!job) throw new Error("no event was queued");
		mocks.attempt
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("retry")
			.mockResolvedValueOnce("delivered");

		expect(await deliverDeveloperWebhookWorkflow(job)).toEqual({
			outcome: "delivered",
			attempts: 3,
		});
		const sent = mocks.attempt.mock.calls.map(([attempt]) => attempt);
		expect(sent).toEqual([job, job, job]);
		expect(JSON.parse(sent[2]?.body ?? "{}")).toMatchObject({
			id: developerVideoEventId("video-1", "video.ready"),
			data: { hlsUrl: expect.stringContaining("/master.m3u8") },
		});
	});

	it("queues one delivery for each endpoint that wants the event", async () => {
		mocks.endpoints.push(
			{
				id: "wh-2",
				appId: "app-1",
				events: ["video.ready"],
				enabled: true,
				deletedAt: null,
			},
			{
				id: "wh-errors-only",
				appId: "app-1",
				events: ["video.errored"],
				enabled: true,
				deletedAt: null,
			},
			{
				id: "wh-off",
				appId: "app-1",
				events: ["video.ready"],
				enabled: false,
				deletedAt: null,
			},
			{
				id: "wh-other-app",
				appId: "app-2",
				events: ["video.ready"],
				enabled: true,
				deletedAt: null,
			},
		);
		await Promise.all([mp4Done(), hlsDone()]);
		await settled();
		expect(jobs().map((job) => job.endpointId)).toEqual(["wh-1", "wh-2"]);
		expect(new Set(jobs().map((job) => job.eventId)).size).toBe(1);
		expect(new Set(jobs().map((job) => job.body)).size).toBe(1);
	});

	it("reads nothing more and queues nothing for an app with no endpoints", async () => {
		mocks.endpoints = [];
		await mp4Done();
		await hlsDone();
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.endpointQueries).toBe(1);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("asks about endpoints only when an event is due", async () => {
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "processing", jobId: "job-9" },
			"mp4",
			"m1",
		);
		await mp4Done();
		await settled();
		expect(mocks.endpointQueries).toBe(0);
	});
});

describe("video.errored", () => {
	it("queues one event when processing fails, and none when failed again", async () => {
		await failDeveloperVideoProcessing("video-1", "encode-1", "Too long");
		await failDeveloperVideoProcessing("video-1", "encode-1", "Too long");
		await settled();

		expect(video().status).toBe("errored");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		const [job] = jobs();
		expect(job).toMatchObject({
			eventType: "video.errored",
			eventId: developerVideoEventId("video-1", "video.errored"),
		});
		expect(JSON.parse(job?.body ?? "{}").data).toMatchObject({
			status: "errored",
			errorReason: "Too long",
		});
	});

	it("queues nothing for an output that fails after the video is ready", async () => {
		await mp4Done();
		await hlsDone();
		await settled();
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "boom" },
			"hls",
			"h1",
		);
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "error", error: "boom" },
			"hls",
			"h1",
		);
		await settled();
		expect(video().status).toBe("ready");
		expect(jobs().map((job) => job.eventType)).toEqual(["video.ready"]);
	});
});

describe("queueing an event", () => {
	it("sends nothing for a status that was never committed", async () => {
		const queued = await enqueueDeveloperVideoEvent(
			{ id: "video-1", appId: "app-1" },
			"video.ready",
		);
		expect(queued).toBe(0);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("sends nothing for a deleted video", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			deletedAt: new Date(),
		});
		expect(
			await enqueueDeveloperVideoEvent(
				{ id: "video-1", appId: "app-1" },
				"video.ready",
			),
		).toBe(0);
	});

	it("uses the same event id and data when it is called again", async () => {
		mocks.store.video = developerVideo({ status: "ready" });
		const target = { id: "video-1", appId: "app-1" };
		await enqueueDeveloperVideoEvent(target, "video.ready");
		await enqueueDeveloperVideoEvent(target, "video.ready");
		const [first, second] = jobs();
		expect(first?.eventId).toBe(second?.eventId);
		expect(JSON.parse(first?.body ?? "{}").data).toEqual(
			JSON.parse(second?.body ?? "{}").data,
		);
	});
});

describe("webhooks never hold up a video", () => {
	it("marks the video ready while the customer's endpoint is still hanging", async () => {
		const hanging = new Promise<never>(() => {});
		mocks.start.mockReturnValue(hanging);

		vi.useRealTimers();
		const started = performance.now();
		expect(await mp4Done()).toEqual({ success: true, applied: true });
		expect(await hlsDone()).toEqual({ success: true, applied: true });
		await settled();

		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(video().status).toBe("ready");
		expect(video().processing?.hls.state).toBe("complete");
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("records the outputs when queueing the delivery fails", async () => {
		mocks.start.mockRejectedValue(new Error("queue is down"));
		expect(await mp4Done()).toEqual({ success: true, applied: true });
		expect(await hlsDone()).toEqual({ success: true, applied: true });
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(video().status).toBe("ready");
		expect(video().processing?.hls.state).toBe("complete");
	});

	it("records the outputs when the endpoint lookup fails", async () => {
		mocks.failEndpointQuery = true;
		expect(await mp4Done()).toEqual({ success: true, applied: true });
		expect(await hlsDone()).toEqual({ success: true, applied: true });
		await settled();
		expect(mocks.endpointQueries).toBe(1);
		expect(video().status).toBe("ready");
		expect(video().processing?.hls.state).toBe("complete");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("records a failure while the endpoint lookup is still hanging", async () => {
		mocks.hangEndpointQuery = true;
		await failDeveloperVideoProcessing("video-1", "encode-1", "Too long");
		expect(video().status).toBe("errored");
		expect(mocks.endpointQueries).toBe(1);
		expect(mocks.start).not.toHaveBeenCalled();
	});
});

describe("deciding the event inside the status write", () => {
	const complete = { state: "complete" as const, output: "o" };
	const now = 10_000_000;

	it("sends video.ready at once when every output has settled", () => {
		const processing = processingState({
			mp4: complete,
			hls: { state: "unavailable", reason: "no ladder", retryAt: now + 1 },
		});
		expect(
			developerVideoEventStep(
				{ status: "processing", processing },
				{ status: "ready", processing },
				now,
			),
		).toEqual({ type: "video.ready" });
	});

	it("marks the video and waits while an output is still encoding", () => {
		const processing = processingState({ mp4: complete, hls: running("h") });
		expect(
			developerVideoEventStep(
				{ status: "processing", processing },
				{ status: "ready", processing },
				now,
			),
		).toEqual({
			type: null,
			processing: { ...processing, readyEventDueAt: now },
		});
	});

	it("sends it once the waiting output settles, and clears the mark", () => {
		const waiting = processingState({
			mp4: complete,
			hls: running("h"),
			readyEventDueAt: now,
		});
		const settledState = { ...waiting, hls: complete };
		const step = developerVideoEventStep(
			{ status: "ready", processing: waiting },
			{ status: "ready", processing: settledState },
			now + 5_000,
		);
		expect(step.type).toBe("video.ready");
		expect(step.processing).not.toHaveProperty("readyEventDueAt");
		expect(
			developerVideoEventStep(
				{ status: "ready", processing: step.processing ?? null },
				{ status: "ready", processing: step.processing ?? null },
				now + 6_000,
			),
		).toEqual({ type: null });
	});

	it("sends it once the wait runs out, even with an output still encoding", () => {
		const waiting = processingState({
			mp4: complete,
			hls: running("h"),
			readyEventDueAt: now,
		});
		const video = { status: "ready", processing: waiting };
		expect(
			developerVideoEventStep(video, video, now + READY_EVENT_MAX_WAIT_MS - 1),
		).toEqual({ type: null });
		expect(
			developerVideoEventStep(video, video, now + READY_EVENT_MAX_WAIT_MS).type,
		).toBe("video.ready");
	});

	it("sends nothing for a ready video without the mark", () => {
		const before = processingState({ mp4: complete, hls: running("h") });
		const after = { ...before, hls: complete };
		expect(
			developerVideoEventStep(
				{ status: "ready", processing: before },
				{ status: "ready", processing: after },
				now + 10 * READY_EVENT_MAX_WAIT_MS,
			),
		).toEqual({ type: null });
		expect(
			developerVideoEventStep(
				{ status: "ready", processing: null },
				{ status: "ready", processing: null },
				now,
			),
		).toEqual({ type: null });
	});

	it("sends video.errored on the change to errored, as before", () => {
		const processing = processingState();
		expect(
			developerVideoEventStep(
				{ status: "processing", processing },
				{ status: "errored", processing },
				now,
			),
		).toEqual({ type: "video.errored" });
		expect(
			developerVideoEventStep(
				{ status: "errored", processing },
				{ status: "errored", processing },
				now,
			),
		).toEqual({ type: null });
	});
});

describe("a rolled back announcement", () => {
	it("is not sent while the committed row still carries the mark", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "m0" },
				hls: { state: "complete", output: "h0" },
				readyEventDueAt: 1,
			}),
		});
		expect(
			await enqueueDeveloperVideoEvent(
				{ id: "video-1", appId: "app-1" },
				"video.ready",
			),
		).toBe(0);
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
