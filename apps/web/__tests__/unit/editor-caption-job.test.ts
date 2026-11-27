import type { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Database, Storage } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import type { EditTranscript } from "../../lib/edit-transcript";
import { inspectEditorCaptionJob } from "../../lib/editor-caption-job";
import { buildEditorCaptionSourcePlan } from "../../lib/editor-caption-sources";

const state = vi.hoisted(() => ({
	stored: null as string | null,
	instance: null as unknown,
	accessOptions: [] as unknown[],
	legacyEdit: null as {
		sourceKey: string;
		editSpec: { sourceDuration: number };
	} | null,
	probed: [] as string[],
	probeDuration: 60,
	updates: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("../../lib/edit-transcript-storage", () => ({
	decryptEditTranscriptObject: (value: string) => value,
}));
vi.mock("../../lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("../../lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	probeVideoViaMediaServer: async (url: string) => {
		state.probed.push(url);
		return { duration: state.probeDuration };
	},
}));
vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: vi.fn(),
}));
vi.mock("../../lib/queue-video-transcription", () => ({
	queueVideoTranscription: vi.fn(),
}));

function metadata(): VideoMetadata {
	const path = "content/videos/00000000-0000-4000-8000-000000000001.webm";
	return {
		editorSources: {
			version: 1,
			display: {
				key: "owner/video/display.webm",
				contentType: "video/webm",
				size: 4000,
				objectIdentity: JSON.stringify("base"),
			},
		},
		webEditorVideos: {
			version: 1,
			items: [
				{
					key: "owner/video/editor-assets/videos/00000000-0000-4000-8000-000000000001.webm",
					path,
					name: "Added clip",
					contentType: "video/webm",
					size: 3000,
					objectIdentity: JSON.stringify("clip"),
				},
			],
		},
		webEditorClips: {
			version: 1,
			items: [{ displayPath: path, duration: 5, fps: 30, hasAudio: true }],
		},
	};
}

function transcript(): EditTranscript {
	return {
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs: 15_000,
		languageCode: "en",
		words: [
			{
				id: "first",
				text: "Original",
				startMs: 500,
				endMs: 900,
				confidence: null,
				speaker: null,
				channel: null,
			},
			{
				id: "second",
				text: "Added",
				startMs: 10_500,
				endMs: 10_900,
				confidence: null,
				speaker: null,
				channel: null,
			},
		],
	};
}

function editorVideo(details: VideoMetadata) {
	return {
		id: "video",
		ownerId: "owner",
		duration: 10,
		metadata: details,
		source: { type: "webMP4", outputKey: "owner/video/result.mp4" },
	} as unknown as typeof videos.$inferSelect;
}

function read(video: typeof videos.$inferSelect) {
	const bucket = {
		getObject: () => Effect.succeed(Option.fromNullable(state.stored)),
		getInternalSignedObjectUrl: (key: string) =>
			Effect.succeed(`https://storage.test/${key}`),
		headObject: () =>
			Effect.succeed({ ContentLength: 4000, ETag: JSON.stringify("original") }),
	};
	const service = {
		getAccessForVideo: (_video: unknown, options: unknown) => {
			state.accessOptions.push(options);
			return Effect.succeed([bucket]);
		},
	} as unknown as Storage;
	const database = Database.make({
		use: (callback) =>
			Effect.promise(() =>
				callback({
					select: () => ({
						from: () => ({
							where: async () => (state.legacyEdit ? [state.legacyEdit] : []),
						}),
					}),
					update: () => ({
						set: () => ({
							where: async () => {
								state.updates++;
								return [{ affectedRows: 1 }];
							},
						}),
					}),
				} as unknown as Parameters<typeof callback>[0]),
			),
	});
	return Effect.runPromise(
		inspectEditorCaptionJob(video).pipe(
			Effect.provideService(Storage, service),
			Effect.provideService(Database, database),
		),
	);
}

function prepare() {
	state.instance = {
		recordings: {
			segments: [
				{ display: { duration: 10 }, camera: null, mic: null },
				{ display: { duration: 5 }, camera: null, mic: null },
			],
		},
	};
	const details = metadata();
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		state.instance,
	);
	if (!plan) throw new Error("Missing caption plan");
	return { details, plan };
}

afterEach(() => {
	state.probed.length = 0;
	state.probeDuration = 60;
	state.updates = 0;
	state.stored = null;
	state.instance = null;
	state.accessOptions.length = 0;
	state.legacyEdit = null;
});

test("completed clip captions are served in desktop source time", async () => {
	const { details, plan } = prepare();
	state.stored = JSON.stringify(transcript());
	const result = await read(editorVideo(details));
	expect(result.plan.combinedKey).toBe(plan.combinedKey);
	expect(result.snapshot.status).toBe("ready");
	expect(
		result.snapshot.captions?.segments[0]?.words.map((word) => word.start),
	).toEqual([0.5, 10.5]);
	expect(state.accessOptions).toEqual([{ resolvePublishedOutput: false }]);
});

test("a fresh clip job reports processing before its transcript exists", async () => {
	const { details, plan } = prepare();
	details.webEditorCaptionJob = {
		status: "processing",
		requestId: "request-1",
		sourceHash: plan.hash,
		requestedAt: new Date().toISOString(),
	};
	expect((await read(editorVideo(details))).snapshot.status).toBe("processing");
});

test("a changed source invalidates an earlier clip transcript job", async () => {
	const { details, plan } = prepare();
	details.webEditorCaptionJob = {
		status: "processing",
		requestId: "request-1",
		sourceHash: plan.hash,
		requestedAt: new Date().toISOString(),
	};
	const asset = details.webEditorVideos?.items[0];
	if (!asset) throw new Error("Missing clip asset");
	asset.objectIdentity = JSON.stringify("new-object");
	expect((await read(editorVideo(details))).snapshot.status).toBe("missing");
});

test("clip durations come from the recording's metadata", async () => {
	const { details, plan } = prepare();
	const result = await read(editorVideo(details));
	expect(result.plan.hash).toBe(plan.hash);
	expect(result.plan.sources.map((source) => source.mediaDurationMs)).toEqual([
		10_000, 5000,
	]);
});

test("a migrated edit caption job measures the preserved MP4 before using its cache", async () => {
	const { details } = prepare();
	state.legacyEdit = {
		sourceKey: "owner/video/source/original.mp4",
		editSpec: { sourceDuration: 10 },
	};
	const result = await read(editorVideo(details));
	expect(result.plan.sources[0]).toMatchObject({
		key: state.legacyEdit.sourceKey,
		expectedSize: 4000,
		expectedIdentity: JSON.stringify("original"),
	});
	expect(result.snapshot.status).toBe("missing");
	expect(state.accessOptions).toEqual([
		{ resolvePublishedOutput: false },
		{ resolvePublishedOutput: false },
	]);
});

test("a farm-saved Studio recording transcribes its retained source, not the share transcript", async () => {
	const { usesEditorCaptionJob } = await import(
		"../../lib/editor-caption-snapshot"
	);
	const outputKey =
		"owner/video/.recording/outputs/render-00000000-0000-4000-8000-000000000002/result.mp4";
	const saved = {
		...editorVideo({}),
		source: { type: "webMP4", outputKey },
	} as typeof videos.$inferSelect;
	expect(usesEditorCaptionJob(editorVideo({}), "auto")).toBe(false);
	expect(usesEditorCaptionJob(saved, "auto")).toBe(true);
	expect(
		usesEditorCaptionJob(
			{
				...saved,
				metadata: {
					renderFarmSave: {
						version: 1,
						exportId: "00000000-0000-4000-8000-000000000002",
						jobId: "job",
						status: "published",
						trigger: "recording",
						startedAt: "2026-11-23T00:00:00.000Z",
						outputKey,
						hlsPrefix: "owner/video/.recording/render/hls",
					},
				},
			},
			"auto",
		),
	).toBe(false);
});

test("a trimmed Save plans captions with the recording's own duration", async () => {
	const { details } = prepare();
	const savedOutput =
		"owner/video/.recording/outputs/render-00000000-0000-4000-8000-000000000002/result.mp4";
	const trimmed = {
		...editorVideo({ ...details, editorSourceDuration: 10 }),
		duration: 4,
		source: { type: "webMP4", outputKey: savedOutput },
	} as typeof videos.$inferSelect;
	const result = await read(trimmed);
	expect(result.plan.sources.map((source) => source.mediaDurationMs)).toEqual([
		10_000, 5000,
	]);
	expect(state.probed).toEqual([]);
});

test("a Save replaced before the duration was kept measures its retained source once", async () => {
	const { details } = prepare();
	state.probeDuration = 10;
	const trimmed = {
		...editorVideo(details),
		duration: 4,
		source: {
			type: "webMP4",
			outputKey:
				"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000003/result.mp4",
		},
	} as typeof videos.$inferSelect;
	const result = await read(trimmed);
	expect(state.probed).toEqual([
		"https://storage.test/owner/video/display.webm",
	]);
	expect(state.updates).toBe(1);
	expect(result.plan.sources.map((source) => source.mediaDurationMs)).toEqual([
		10_000, 5000,
	]);
});
