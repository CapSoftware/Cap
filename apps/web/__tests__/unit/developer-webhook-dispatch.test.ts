import { beforeEach, describe, expect, it, vi } from "vitest";
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
	start: vi.fn(),
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
			const next = turn.then(() => run(database));
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

const { applyDeveloperVideoProgress, failDeveloperVideoProcessing } =
	await import("@/lib/developer-video-processing");
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

beforeEach(() => {
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
	mocks.start.mockResolvedValue({ runId: "run-1" });
	mocks.head.mockResolvedValue({ bytes: 2_000, contentType: "video/mp4" });
	mocks.readText.mockResolvedValue(master);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("video.ready", () => {
	it("queues one delivery carrying the video as GET /videos/:id returns it", async () => {
		await mp4Done();
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
		expect(job?.body).not.toContain("s3Key");
		expect(job?.body).not.toContain("developer/app-1");
	});

	it("queues nothing more when the encoder's callback arrives twice", async () => {
		await mp4Done();
		await mp4Done();
		await mp4Done();
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("queues one event when both outputs finish at once", async () => {
		await Promise.all([mp4Done(), hlsDone()]);
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(jobs()[0]?.eventType).toBe("video.ready");
	});

	it("queues nothing when the second output finishes later", async () => {
		await mp4Done();
		await settled();
		await hlsDone();
		await settled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
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
		await mp4Done();
		await settled();
		expect(jobs().map((job) => job.endpointId)).toEqual(["wh-1", "wh-2"]);
		expect(new Set(jobs().map((job) => job.eventId)).size).toBe(1);
		expect(new Set(jobs().map((job) => job.body)).size).toBe(1);
	});

	it("reads nothing more and queues nothing for an app with no endpoints", async () => {
		mocks.endpoints = [];
		await mp4Done();
		await settled();
		expect(video().status).toBe("ready");
		expect(mocks.endpointQueries).toBe(1);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("asks about endpoints only when the status changes", async () => {
		await applyDeveloperVideoProgress(
			{ videoId: "video-1", phase: "processing", jobId: "job-9" },
			"mp4",
			"m1",
		);
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

		const started = Date.now();
		const result = await mp4Done();

		expect(result).toEqual({ success: true, applied: true });
		expect(video().status).toBe("ready");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("marks the video ready when queueing the delivery fails", async () => {
		mocks.start.mockRejectedValue(new Error("queue is down"));
		expect(await mp4Done()).toEqual({ success: true, applied: true });
		await settled();
		expect(video().status).toBe("ready");
	});

	it("marks the video ready when the endpoint lookup fails", async () => {
		mocks.failEndpointQuery = true;
		expect(await mp4Done()).toEqual({ success: true, applied: true });
		await settled();
		expect(video().status).toBe("ready");
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
