import type { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Database, Storage } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import type { EditTranscript } from "../lib/edit-transcript";
import { inspectEditorCaptionJob } from "../lib/editor-caption-job";
import { buildEditorCaptionSourcePlan } from "../lib/editor-caption-sources";

const state = vi.hoisted(() => ({
	stored: null as string | null,
	instance: null as unknown,
	accessOptions: [] as unknown[],
	legacyEdit: null as { sourceKey: string } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("../lib/edit-transcript-storage", () => ({
	decryptEditTranscriptObject: (value: string) => value,
}));
vi.mock("../lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("../lib/editor-session", async () => {
	const { Effect } = await import("effect");
	return {
		requestMediaEditor: () => Effect.succeed(Response.json(state.instance)),
	};
});
vi.mock("workflow/api", () => ({ start: vi.fn() }));

function metadata(): VideoMetadata {
	const path = "content/videos/00000000-0000-4000-8000-000000000001.webm";
	return {
		editorSources: {
			version: 1,
			display: {
				key: "owner/video/display.webm",
				contentType: "video/webm",
				size: 4000,
				objectIdentity: '"base"',
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
					objectIdentity: '"clip"',
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
		metadata: details,
		source: { type: "webMP4", outputKey: "owner/video/result.mp4" },
	} as unknown as typeof videos.$inferSelect;
}

function read(video: typeof videos.$inferSelect) {
	const bucket = {
		getObject: () => Effect.succeed(Option.fromNullable(state.stored)),
		headObject: () =>
			Effect.succeed({ ContentLength: 4000, ETag: '"original"' }),
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
				} as unknown as Parameters<typeof callback>[0]),
			),
	});
	return Effect.runPromise(
		inspectEditorCaptionJob(video, "/editor/sessions/session").pipe(
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
	asset.objectIdentity = '"new-object"';
	expect((await read(editorVideo(details))).snapshot.status).toBe("missing");
});

test("a migrated edit caption job measures the preserved MP4 before using its cache", async () => {
	const { details } = prepare();
	state.legacyEdit = { sourceKey: "owner/video/source/original.mp4" };
	const result = await read(editorVideo(details));
	expect(result.plan.sources[0]).toMatchObject({
		key: state.legacyEdit.sourceKey,
		expectedSize: 4000,
		expectedIdentity: '"original"',
	});
	expect(result.snapshot.status).toBe("missing");
	expect(state.accessOptions).toEqual([
		{ resolvePublishedOutput: false },
		{ resolvePublishedOutput: false },
	]);
});
