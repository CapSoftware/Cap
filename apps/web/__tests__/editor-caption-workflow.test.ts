import type { VideoMetadata } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { afterEach, expect, test, vi } from "vitest";
import {
	type EditTranscript,
	getEditTranscriptObjectKey,
	serializeEditTranscript,
} from "../lib/edit-transcript";
import {
	buildEditorCaptionSourcePlan,
	type EditorCaptionSourcePlan,
} from "../lib/editor-caption-sources";
import { transcribeWebEditorCaptionsWorkflow } from "../lib/editor-caption-workflow";

const state = vi.hoisted(() => ({
	row: null as Record<string, unknown> | null,
	legacyEdit: null as { sourceKey: string } | null,
	isPro: true,
	baseEtag: '"base"',
	objects: new Map<string, string>(),
	writes: [] as Array<{ key: string; value: string }>,
	transcribe: vi.fn(),
	urls: [] as string[],
	workerRequests: [] as Array<{
		path: string;
		body: unknown;
		workerId: string | undefined;
	}>,
	updates: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ASSEMBLY_API_KEY: "assembly-test-key" }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => state.isPro }));
vi.mock("@cap/database/schema", () => ({
	users: { id: "users.id" },
	videoEdits: {
		videoId: "video_edits.videoId",
		sourceKey: "video_edits.sourceKey",
	},
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		metadata: "videos.metadata",
		updatedAt: "videos.updatedAt",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => conditions,
	eq: (field: unknown, value: unknown) => ({ field, value }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) =>
				typeof table === "object" && table !== null && "videoId" in table
					? {
							where: async () => (state.legacyEdit ? [state.legacyEdit] : []),
						}
					: {
							innerJoin: () => ({
								where: async () => [
									{ video: state.row, owner: { id: "owner" } },
								],
							}),
						},
		}),
		update: () => ({
			set: (value: unknown) => {
				state.updates.push(value);
				return { where: async () => [{ affectedRows: 1 }] };
			},
		}),
	}),
}));
vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: state.transcribe };
	},
}));
vi.mock("../lib/edit-transcript-storage", () => ({
	encryptEditTranscriptObject: (value: string) => value,
	decryptEditTranscriptObject: (value: string) => value,
}));
vi.mock("../lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));
vi.mock("../lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("../lib/editor-session", () => ({
	requestMediaEditor: (
		path: string,
		init?: RequestInit,
		_timeoutMs?: number,
		workerId?: string,
	) => {
		state.workerRequests.push({
			path,
			body: JSON.parse(String(init?.body)),
			workerId,
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			}),
			{
				headers: {
					"Content-Type": "audio/mp4",
					"Content-Length": "3",
				},
			},
		);
		return {
			pipe: (runner: (value: Response) => unknown) => runner(response),
		};
	},
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Option } = await import("effect");
	const pipe = (value: unknown) => ({
		pipe: (runner: (input: unknown) => unknown) => runner(value),
	});
	return {
		Storage: {
			getAccessForVideo: () =>
				pipe([
					{
						getObject: (key: string) =>
							pipe(Option.fromNullable(state.objects.get(key))),
						headObject: (key: string) => {
							const details = state.row?.metadata as VideoMetadata | undefined;
							const asset = details?.webEditorVideos?.items.find(
								(candidate) => candidate.key === key,
							);
							return pipe({
								ContentLength: asset?.size ?? 4000,
								ETag: asset?.objectIdentity ?? state.baseEtag,
							});
						},
						getInternalSignedObjectUrl: (key: string) => {
							state.urls.push(key);
							return pipe(`https://objects.example/${key}`);
						},
						putObject: (key: string, value: string) => {
							state.writes.push({ key, value });
							state.objects.set(key, value);
							return pipe({});
						},
					},
				]),
		},
	};
});

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

function baseTranscript(): EditTranscript {
	return {
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs: 10_000,
		languageCode: "en",
		words: [
			{
				id: "base-word",
				text: "Original",
				startMs: 1000,
				endMs: 1400,
				confidence: null,
				speaker: null,
				channel: null,
			},
		],
	};
}

function prepareWithAddedClips(
	count: number,
	language: "auto" | "es" = "auto",
): EditorCaptionSourcePlan {
	const details = metadata();
	const videos = details.webEditorVideos?.items;
	const clips = details.webEditorClips?.items;
	const firstVideo = videos?.[0];
	const firstClip = clips?.[0];
	if (!videos || !clips || !firstVideo || !firstClip) {
		throw new Error("Missing caption clip fixtures");
	}
	for (let index = 2; index <= count; index++) {
		const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
		const path = `content/videos/${id}.webm`;
		videos.push({
			...firstVideo,
			key: `owner/video/editor-assets/videos/${id}.webm`,
			path,
			name: `Added clip ${index}`,
		});
		clips.push({ ...firstClip, displayPath: path });
	}
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		{
			recordings: {
				segments: [
					{ display: { duration: 10 }, camera: null, mic: null },
					...clips.map(() => ({
						display: { duration: 5 },
						camera: null,
						mic: null,
					})),
				],
			},
		},
		"",
		language,
	);
	if (!plan) throw new Error("Caption plan is invalid");
	details.webEditorCaptionJob = {
		status: "processing",
		requestId: "request-1",
		sourceHash: plan.hash,
		requestedAt: new Date().toISOString(),
	};
	state.row = {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4", outputKey: "owner/video/result.mp4" },
		transcriptionStatus: "COMPLETE",
		metadata: details,
	};
	state.objects.set(
		getEditTranscriptObjectKey("owner", "video"),
		serializeEditTranscript(baseTranscript()),
	);
	return plan;
}

function prepare(language: "auto" | "es" = "auto"): EditorCaptionSourcePlan {
	return prepareWithAddedClips(1, language);
}

function prepareLegacy(language: "auto" | "es" = "es") {
	prepare(language);
	const details = state.row?.metadata as VideoMetadata | undefined;
	if (!details?.webEditorClips)
		throw new Error("Missing migrated caption clips");
	const sourceKey = "owner/video/source/original.mp4";
	state.legacyEdit = { sourceKey };
	state.baseEtag = '"original"';
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		{
			recordings: {
				segments: [
					{ display: { duration: 10 }, camera: null, mic: null },
					{ display: { duration: 5 }, camera: null, mic: null },
				],
			},
		},
		"",
		language,
		{ key: sourceKey, size: 4000, objectIdentity: '"original"' },
	);
	if (!plan || !details.webEditorCaptionJob) {
		throw new Error("Missing migrated caption plan");
	}
	details.webEditorCaptionJob.sourceHash = plan.hash;
	return plan;
}

function prepareWithCap(): EditorCaptionSourcePlan {
	const details = metadata();
	const capId = "9a2aa734-d076-42c0-8a8a-68db1d2d2a1e";
	const capPath = `content/imports/${capId}.capbundle`;
	const clipPath = details.webEditorClips?.items[0]?.displayPath;
	if (!clipPath) throw new Error("Missing MP4 caption fixture");
	details.webEditorVideos?.items.push({
		key: `owner/video/editor-assets/recordings/${capId}.capbundle`,
		path: capPath,
		name: "Studio recording",
		contentType: CAP_BUNDLE_CONTENT_TYPE,
		size: 8000,
		objectIdentity: '"cap"',
	});
	details.webEditorImports = {
		version: 1,
		items: [
			{ kind: "cap", path: capPath, clipCount: 2 },
			{ kind: "clip", path: clipPath },
		],
	};
	const plan = buildEditorCaptionSourcePlan(
		"owner",
		"video",
		details,
		{
			recordings: {
				segments: [
					{ display: { duration: 10 }, camera: null, mic: null },
					{
						display: { duration: 3 },
						camera: null,
						mic: { duration: 3 },
					},
					{
						display: { duration: 2 },
						camera: null,
						mic: null,
						system_audio: { duration: 2 },
					},
					{ display: { duration: 5 }, camera: null, mic: null },
				],
			},
		},
		"worker-a",
	);
	if (!plan) throw new Error("Cap caption plan is invalid");
	details.webEditorCaptionJob = {
		status: "processing",
		requestId: "request-1",
		sourceHash: plan.hash,
		requestedAt: new Date().toISOString(),
	};
	state.row = {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4", outputKey: "owner/video/result.mp4" },
		transcriptionStatus: "COMPLETE",
		metadata: details,
	};
	state.objects.set(
		getEditTranscriptObjectKey("owner", "video"),
		serializeEditTranscript(baseTranscript()),
	);
	const clipSource = plan.sources[2];
	if (!clipSource) throw new Error("Missing MP4 caption source");
	state.objects.set(
		clipSource.transcriptKey,
		serializeEditTranscript({
			...baseTranscript(),
			durationMs: 5000,
			words: [],
		}),
	);
	return plan;
}

afterEach(() => {
	state.row = null;
	state.legacyEdit = null;
	state.isPro = true;
	state.baseEtag = '"base"';
	state.objects.clear();
	state.writes.length = 0;
	state.urls.length = 0;
	state.workerRequests.length = 0;
	state.updates.length = 0;
	state.transcribe.mockReset();
});

test("added clip uses the same AssemblyAI model options and reuses share-link words", async () => {
	const plan = prepare();
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Added", start: 500, end: 900 }],
		speech_model_used: "universal-3-5-pro",
		language_code: "en",
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.transcribe).toHaveBeenCalledOnce();
	expect(state.transcribe.mock.calls[0]?.[0]).toMatchObject({
		audio: `https://objects.example/${plan.sources[1]?.key}`,
		speech_models: ["universal-3-5-pro", "universal-2"],
		language_detection: true,
		disfluencies: true,
	});
	expect(state.urls).toEqual([plan.sources[1]?.key]);
	const combined = state.objects.get(plan.combinedKey);
	expect(
		JSON.parse(combined ?? "{}").words.map(
			(word: { text: string; startMs: number }) => [word.text, word.startMs],
		),
	).toEqual([
		["Original", 1000],
		["Added", 10_500],
	]);
});

test("Spanish caption generation uses AssemblyAI language_code without reusing auto share words", async () => {
	const plan = prepare("es");
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Hola", start: 500, end: 900 }],
		speech_model_used: "universal-3-5-pro",
		language_code: "es",
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.transcribe).toHaveBeenCalledTimes(2);
	for (const [index, call] of state.transcribe.mock.calls.entries()) {
		expect(call[0]).toMatchObject({
			audio: `https://objects.example/${plan.sources[index]?.key}`,
			speech_models: ["universal-3-5-pro", "universal-2"],
			language_code: "es",
		});
		expect(call[0]).not.toHaveProperty("language_detection");
	}
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words.map(
			(word: { text: string; startMs: number }) => [word.text, word.startMs],
		),
	).toEqual([
		["Hola", 500],
		["Hola", 10_500],
	]);
});

test("a migrated trim captions its preserved MP4 through AssemblyAI", async () => {
	const plan = prepareLegacy();
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Hola", start: 500, end: 900 }],
		speech_model_used: "universal-3-5-pro",
		language_code: "es",
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.urls).toEqual(plan.sources.map((source) => source.key));
	expect(state.urls[0]).toBe("owner/video/source/original.mp4");
	expect(state.transcribe).toHaveBeenCalledTimes(2);
	expect(state.transcribe.mock.calls[0]?.[0]).toMatchObject({
		language_code: "es",
	});
});

test("a changed preserved MP4 stops migrated captions before AssemblyAI", async () => {
	const plan = prepareLegacy();
	state.baseEtag = '"replacement"';
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: false });
	expect(state.transcribe).not.toHaveBeenCalled();
});

test("Studio Cap voice audio streams through AssemblyAI without local model calls", async () => {
	const plan = prepareWithCap();
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Cap", start: 500, end: 900 }],
		speech_model_used: "universal-3-5-pro",
		language_code: "en",
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.workerRequests).toHaveLength(1);
	expect(state.workerRequests[0]).toMatchObject({
		path: "/editor/caption-cap-audio",
		workerId: "worker-a",
		body: {
			asset: {
				path: plan.sources[1]?.cap?.path,
				name: "Studio recording",
				size: 8000,
				contentType: CAP_BUNDLE_CONTENT_TYPE,
				objectIdentity: '"cap"',
			},
			segments: plan.sources[1]?.cap?.segments,
		},
	});
	expect(state.transcribe).toHaveBeenCalledOnce();
	expect(state.transcribe.mock.calls[0]?.[0]).toMatchObject({
		speech_models: ["universal-3-5-pro", "universal-2"],
		language_detection: true,
		disfluencies: true,
	});
	expect(state.transcribe.mock.calls[0]?.[0].audio).toBeInstanceOf(
		ReadableStream,
	);
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words.map(
			(word: { text: string; startMs: number }) => [word.text, word.startMs],
		),
	).toEqual([
		["Original", 1000],
		["Cap", 10_500],
	]);
});

test("expired Pro entitlement stops a Cap caption mix before provider calls", async () => {
	const plan = prepareWithCap();
	state.isPro = false;
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: false });
	expect(state.workerRequests).toHaveLength(0);
	expect(state.transcribe).not.toHaveBeenCalled();
});

test("unchanged raw source and added clip keep their cached captions after a rendered reupload", async () => {
	const plan = prepare();
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Added", start: 500, end: 900 }],
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(
		JSON.parse(state.objects.get(plan.sources[0]?.transcriptKey ?? "") ?? "{}")
			.words[0]?.text,
	).toBe("Original");
	if (!state.row) throw new Error("Missing video row");
	state.row.source = {
		type: "webMP4",
		outputKey:
			"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000001/result.mp4",
	};
	state.row.transcriptionStatus = "NO_AUDIO";
	state.objects.delete(plan.combinedKey);
	state.urls.length = 0;
	state.transcribe.mockReset();
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.transcribe).not.toHaveBeenCalled();
	expect(state.urls).toHaveLength(0);
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words.map(
			(word: { text: string }) => word.text,
		),
	).toEqual(["Original", "Added"]);
});

test("changed raw media metadata stops the job before any provider call", async () => {
	const plan = prepare();
	if (!state.row) throw new Error("Missing video row");
	const details = state.row.metadata as VideoMetadata;
	if (!details.editorSources) throw new Error("Missing source metadata");
	details.editorSources.display.objectIdentity = '"changed"';
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: false });
	expect(state.transcribe).not.toHaveBeenCalled();
	expect(state.writes).toHaveLength(0);
});

test("changed raw object identity stops the job before added clips incur provider calls", async () => {
	const plan = prepare();
	state.baseEtag = '"changed"';
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Added", start: 500, end: 900 }],
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: false });
	expect(state.transcribe).not.toHaveBeenCalled();
	expect(state.writes).toHaveLength(0);
});

test("an expired Pro entitlement prevents a paid provider call", async () => {
	const plan = prepare();
	state.isPro = false;
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: false });
	expect(state.transcribe).not.toHaveBeenCalled();
	expect(state.writes).toHaveLength(0);
});

test("reopened editor captions transcribe the raw source after a rendered reupload", async () => {
	const plan = prepare();
	if (!state.row) throw new Error("Missing video row");
	state.row.source = {
		type: "webMP4",
		outputKey:
			"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000001/result.mp4",
	};
	state.row.transcriptionStatus = "NO_AUDIO";
	state.transcribe.mockImplementation(async (options: { audio: string }) => ({
		status: "completed",
		words: [
			{
				text:
					options.audio === `https://objects.example/${plan.sources[0]?.key}`
						? "Raw"
						: "Added",
				start: 500,
				end: 900,
			},
		],
	}));
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.urls).toEqual(plan.sources.map((source) => source.key));
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words.map(
			(word: { text: string }) => word.text,
		),
	).toEqual(["Raw", "Added"]);
});

test("reuploaded sources transcribe two at a time and keep source order when calls finish together", async () => {
	const plan = prepareWithAddedClips(4);
	if (!state.row) throw new Error("Missing video row");
	state.row.source = {
		type: "webMP4",
		outputKey:
			"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000001/result.mp4",
	};
	state.row.transcriptionStatus = "NO_AUDIO";
	let active = 0;
	let peak = 0;
	const release: Array<() => void> = [];
	state.transcribe.mockImplementation(async (options: { audio: string }) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => release.push(resolve));
		active--;
		const index = plan.sources.findIndex(
			(source) => options.audio === `https://objects.example/${source.key}`,
		);
		return {
			status: "completed",
			words: [{ text: `Clip ${index}`, start: 500, end: 900 }],
		};
	});
	const running = transcribeWebEditorCaptionsWorkflow({
		plan,
		requestId: "request-1",
	});
	await vi.waitFor(() => expect(release).toHaveLength(1));
	expect(state.transcribe).toHaveBeenCalledTimes(1);
	for (const finish of release.splice(0, 1)) finish();
	await vi.waitFor(() => expect(release).toHaveLength(2));
	expect(state.transcribe).toHaveBeenCalledTimes(3);
	for (const finish of release.splice(0, 2)) finish();
	await vi.waitFor(() => expect(release).toHaveLength(2));
	expect(state.transcribe).toHaveBeenCalledTimes(5);
	for (const finish of release.splice(0, 2)) finish();
	expect(await running).toEqual({ success: true });
	expect(peak).toBe(2);
	expect(active).toBe(0);
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words.map(
			(word: { text: string; startMs: number }) => [word.text, word.startMs],
		),
	).toEqual([
		["Clip 0", 500],
		["Clip 1", 10_500],
		["Clip 2", 15_500],
		["Clip 3", 20_500],
		["Clip 4", 25_500],
	]);
});

test("a failed clip waits for its sibling provider call before finishing the job", async () => {
	const plan = prepareWithAddedClips(2);
	const pending = { finish: null as ((value: unknown) => void) | null };
	state.transcribe.mockImplementation((options: { audio: string }) => {
		if (options.audio === `https://objects.example/${plan.sources[1]?.key}`) {
			return Promise.reject(new Error("Provider failed"));
		}
		return new Promise((resolve) => {
			pending.finish = resolve;
		});
	});
	const running = transcribeWebEditorCaptionsWorkflow({
		plan,
		requestId: "request-1",
	});
	await vi.waitFor(() => expect(pending.finish).not.toBeNull());
	expect(state.updates).toHaveLength(0);
	if (!pending.finish) throw new Error("Second provider call did not start");
	pending.finish({
		status: "completed",
		words: [{ text: "Sibling", start: 500, end: 900 }],
	});
	expect(await running).toEqual({ success: false });
	expect(state.updates).toHaveLength(1);
	expect(state.objects.has(plan.sources[2]?.transcriptKey ?? "")).toBe(true);
	expect(state.objects.has(plan.combinedKey)).toBe(false);
});

test("a reuploaded single-clip recording ignores words from the rendered share page", async () => {
	const details = metadata();
	delete details.webEditorClips;
	delete details.webEditorVideos;
	const plan = buildEditorCaptionSourcePlan("owner", "video", details, {
		recordings: {
			segments: [{ display: { duration: 10 }, camera: null, mic: null }],
		},
	});
	if (!plan) throw new Error("Missing single source caption plan");
	details.webEditorCaptionJob = {
		status: "processing",
		requestId: "request-1",
		sourceHash: plan.hash,
		requestedAt: new Date().toISOString(),
	};
	state.row = {
		id: "video",
		ownerId: "owner",
		source: {
			type: "webMP4",
			outputKey:
				"owner/video/.recording/outputs/reupload-00000000-0000-4000-8000-000000000001/result.mp4",
		},
		transcriptionStatus: "COMPLETE",
		metadata: details,
	};
	state.objects.set(
		getEditTranscriptObjectKey("owner", "video"),
		serializeEditTranscript(baseTranscript()),
	);
	state.transcribe.mockResolvedValue({
		status: "completed",
		words: [{ text: "Source", start: 500, end: 900 }],
	});
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(state.transcribe).toHaveBeenCalledOnce();
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words[0]?.text,
	).toBe("Source");
});

test("no spoken audio is cached so later clip edits cannot repay for silence", async () => {
	const plan = prepare();
	state.transcribe.mockRejectedValue(new Error("no spoken audio"));
	expect(
		await transcribeWebEditorCaptionsWorkflow({ plan, requestId: "request-1" }),
	).toEqual({ success: true });
	expect(
		JSON.parse(state.objects.get(plan.sources[1]?.transcriptKey ?? "") ?? "{}")
			.words,
	).toEqual([]);
	expect(
		JSON.parse(state.objects.get(plan.combinedKey) ?? "{}").words,
	).toHaveLength(1);
});
