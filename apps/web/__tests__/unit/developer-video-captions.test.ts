import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		reset: () => void;
	},
	ids: 0,
	start: vi.fn(),
	objects: new Map<string, string>(),
	puts: [] as { key: string; contentType: string }[],
	afterPut: null as null | (() => void),
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerTranscripts,
				() => ({
					externalUserId: null,
					name: "Untitled",
					sourceUrl: null,
					videoId: null,
					resultKey: null,
					sourceBytes: null,
					durationSeconds: null,
					requestedLanguage: null,
					language: null,
					text: null,
					wordCount: null,
					reservedMicroCredits: 0,
					billedMicroCredits: 0,
					errorCode: null,
					errorMessage: null,
					metadata: null,
					runId: null,
					queuedAt: null,
					startedAt: null,
					completedAt: null,
					deletedAt: null,
				}),
			],
			[
				schema.developerVideos,
				() => ({
					name: "Untitled",
					duration: 12,
					status: "ready",
					processing: null,
					deletedAt: null,
					filesDeletedAt: null,
				}),
			],
		]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => {
		context.ids += 1;
		return `generated-${context.ids}`;
	},
	nanoIdLength: 15,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
}));

vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));

vi.mock("workflow/api", () => ({ start: context.start }));

vi.mock("@/workflows/developer-transcribe", () => ({
	developerTranscribeWorkflow: "developer-transcribe-workflow",
}));

vi.mock("@/lib/developer-transcript-speech", () => ({
	isSpeechConfigured: () => true,
	parseTranscriptLanguage: (value: string | null | undefined) => {
		if (!value || value === "auto") return "auto";
		return ["en", "de"].includes(value) ? value : null;
	},
}));

vi.mock("@/lib/developer-transcript-storage", () => ({
	presignDeveloperUpload: async () => "https://storage.example/upload",
	developerObjectSize: async (key: string) =>
		context.objects.get(key)?.length ?? null,
	getDeveloperObjectText: async (key: string) =>
		context.objects.get(key) ?? null,
	putDeveloperObject: async (
		key: string,
		body: string,
		contentType: string,
	) => {
		context.objects.set(key, body);
		context.puts.push({ key, contentType });
		const hook = context.afterPut;
		context.afterPut = null;
		hook?.();
	},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) context.objects.delete(key);
	},
}));

import {
	developerApps,
	developerCreditAccounts,
	developerTranscripts,
	developerVideos,
	users,
} from "@cap/database/schema";
import {
	createTranscriptFromUrl,
	createTranscriptFromVideo,
	deleteTranscript,
	listTranscripts,
} from "@/lib/developer-transcript-store";
import {
	serializeTranscript,
	toAgentDeveloperTranscript,
} from "@/lib/developer-transcripts";
import {
	captionLanguage,
	captionLanguageLabel,
	developerVideoCaptions,
	findVideoForTranscript,
	syncVideoCaptions,
	videoCaptionsKey,
} from "@/lib/developer-video-captions";
import { processingState } from "../fixtures/developer-video";

const VIDEO = { id: "video-1", appId: "app-1" };
const MP4_KEY = "developer/app-1/video-1/encode-1/out-1/video.mp4";
const EN_KEY = "developer/app-1/video-1/captions/en.vtt";
const DE_KEY = "developer/app-1/video-1/captions/de.vtt";

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};

const transcripts = () => fake().rows(developerTranscripts);

const readyProcessing = () =>
	processingState({
		hls: { state: "complete", output: "out-1" },
		mp4: { state: "complete", output: "out-1" },
	});

const seedVideo = (row: Record<string, unknown> = {}) =>
	fake().seed(developerVideos, {
		id: "video-1",
		appId: "app-1",
		name: "Launch walkthrough",
		playbackId: "playback-id-0123456789ab",
		processing: readyProcessing(),
		...row,
	});

const resultFor = (text: string) =>
	JSON.stringify({
		text,
		language: "en",
		durationSeconds: 10,
		words: text.split(" ").map((word, index) => ({
			text: word,
			start: index * 0.5,
			end: index * 0.5 + 0.4,
		})),
		segments: [],
	});

const seedCompleted = (
	id: string,
	text: string,
	row: Record<string, unknown> = {},
) => {
	const resultKey = `developer/app-1/transcripts/${id}/result.json`;
	context.objects.set(resultKey, resultFor(text));
	return fake().seed(developerTranscripts, {
		id,
		appId: "app-1",
		status: "complete",
		sourceType: "video",
		videoId: "video-1",
		language: "en",
		text,
		wordCount: text.split(" ").length,
		resultKey,
		completedAt: new Date("2026-11-12T10:00:00.000Z"),
		...row,
	});
};

beforeEach(() => {
	fake().reset();
	context.ids = 0;
	context.start.mockReset();
	context.start.mockResolvedValue(undefined);
	context.objects = new Map();
	context.puts = [];
	context.afterPut = null;
	fake().seed(users, { id: "owner-1", email: "owner@example.com" });
	for (const id of ["app-1", "app-2"]) {
		fake().seed(developerApps, { id, ownerId: "owner-1", deletedAt: null });
		fake().seed(developerCreditAccounts, {
			id: `account-${id}`,
			appId: id,
			balanceMicroCredits: 100_000,
		});
	}
});

describe("creating a transcript from a stored video", () => {
	it("queues a transcript that reads the video's stored MP4 and starts it once", async () => {
		seedVideo();

		const result = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
		});

		expect(result.ok).toBe(true);
		expect(transcripts()).toHaveLength(1);
		expect(transcripts()[0]).toMatchObject({
			id: "generated-1",
			appId: "app-1",
			status: "queued",
			sourceType: "video",
			videoId: "video-1",
			sourceUrl: null,
			s3Key: MP4_KEY,
			name: "Launch walkthrough",
		});
		expect(context.start).toHaveBeenCalledTimes(1);
		if (!result.ok) throw new Error("create failed");
		expect(serializeTranscript(result.transcript)).toMatchObject({
			source: { type: "video", url: null },
			videoId: "video-1",
		});
		expect(toAgentDeveloperTranscript(result.transcript)).toMatchObject({
			sourceType: "video",
			videoId: "video-1",
		});
	});

	it("keeps the same options as a URL transcript", async () => {
		seedVideo();

		const result = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			name: "Captions run",
			language: "de",
			userId: "user-7",
			metadata: { ticket: 42 },
		});

		expect(result.ok).toBe(true);
		expect(transcripts()[0]).toMatchObject({
			name: "Captions run",
			requestedLanguage: "de",
			externalUserId: "user-7",
			metadata: { ticket: 42 },
		});
		expect(
			await createTranscriptFromVideo("app-1", {
				videoId: "video-1",
				language: "xx",
			}),
		).toMatchObject({ ok: false, status: 400, code: "invalid_language" });
	});

	it.each([
		["uploading", null, "The video is not ready yet"],
		["processing", processingState(), "The video is not ready yet"],
		[
			"errored",
			processingState({ mp4: { state: "failed", reason: "bad file" } }),
			"The video failed to process and has no file to transcribe",
		],
		[
			"ready",
			processingState({
				hls: { state: "complete", output: "out-1" },
				mp4: { state: "failed", reason: "bad file" },
			}),
			"The video has no stored file to transcribe",
		],
	])(
		"answers 409 for a video that is %s without storing or starting anything",
		async (status, processing, message) => {
			seedVideo({ status, processing });

			const result = await createTranscriptFromVideo("app-1", {
				videoId: "video-1",
			});

			expect(result).toMatchObject({
				ok: false,
				status: 409,
				code: "video_not_ready",
				message,
			});
			expect(transcripts()).toHaveLength(0);
			expect(context.start).not.toHaveBeenCalled();
		},
	);

	it("answers 404 for another app's video", async () => {
		seedVideo({ appId: "app-2" });

		expect(
			await createTranscriptFromVideo("app-1", { videoId: "video-1" }),
		).toMatchObject({ ok: false, status: 404, code: "video_not_found" });
		expect(transcripts()).toHaveLength(0);
		expect(context.start).not.toHaveBeenCalled();
	});

	it("answers 404 for a deleted video and for one that never existed", async () => {
		seedVideo({ deletedAt: new Date("2026-11-12T09:00:00.000Z") });

		for (const videoId of ["video-1", "video-unknown"]) {
			expect(
				await createTranscriptFromVideo("app-1", { videoId }),
			).toMatchObject({ ok: false, status: 404, code: "video_not_found" });
		}
		expect(transcripts()).toHaveLength(0);
	});

	it("answers 409 for a video whose files were removed", async () => {
		seedVideo({ filesDeletedAt: new Date("2026-11-12T09:00:00.000Z") });

		expect(
			await createTranscriptFromVideo("app-1", { videoId: "video-1" }),
		).toMatchObject({ ok: false, status: 409, code: "video_not_ready" });
	});

	it("refuses an empty or oversized video id", async () => {
		for (const videoId of ["", "   ", "v".repeat(65)]) {
			expect(
				await createTranscriptFromVideo("app-1", { videoId }),
			).toMatchObject({ ok: false, status: 400, code: "invalid_video_id" });
		}
	});

	it("answers 402 below the minimum balance", async () => {
		seedVideo();
		const account = fake().rows(developerCreditAccounts)[0];
		if (account) account.balanceMicroCredits = 999;

		expect(
			await createTranscriptFromVideo("app-1", { videoId: "video-1" }),
		).toMatchObject({ ok: false, status: 402, code: "insufficient_credits" });
		expect(transcripts()).toHaveLength(0);
	});

	it("lists a video transcript with its video id", async () => {
		seedVideo();
		await createTranscriptFromVideo("app-1", { videoId: "video-1" });

		const listed = await listTranscripts("app-1", { limit: 10 });

		expect(listed.transcripts.map((row) => serializeTranscript(row))).toEqual([
			expect.objectContaining({
				videoId: "video-1",
				source: { type: "video", url: null },
			}),
		]);
	});
});

describe("repeating a video transcript with an Idempotency-Key", () => {
	const KEY = "captions-key-1";

	it("returns the same transcript and starts it once", async () => {
		seedVideo();
		const first = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});
		const second = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error("create failed");
		expect(second.transcript.id).toBe(first.transcript.id);
		expect(transcripts()).toHaveLength(1);
		expect(context.start).toHaveBeenCalledTimes(1);
	});

	it("refuses the key for a different video and names the field", async () => {
		seedVideo();
		seedVideo({ id: "video-2" });
		await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});

		expect(
			await createTranscriptFromVideo("app-1", {
				videoId: "video-2",
				idempotencyKey: KEY,
			}),
		).toMatchObject({
			ok: false,
			status: 409,
			code: "idempotency_conflict",
			message: "Idempotency key was already used with a different videoId",
		});
		expect(transcripts()).toHaveLength(1);
	});

	it.each([
		["name", { name: "Other" }],
		["language", { language: "de" }],
		["userId", { userId: "user-9" }],
		["metadata", { metadata: { a: 1 } }],
	])("refuses the key with a different %s", async (field, change) => {
		seedVideo();
		await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});

		expect(
			await createTranscriptFromVideo("app-1", {
				videoId: "video-1",
				idempotencyKey: KEY,
				...change,
			}),
		).toMatchObject({
			ok: false,
			status: 409,
			message: `Idempotency key was already used with a different ${field}`,
		});
	});

	it("refuses a key that was used for a URL transcript, and the reverse", async () => {
		seedVideo();
		const guards = { isBlocked: async () => false };
		await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});
		await createTranscriptFromUrl(
			"app-1",
			{ url: "https://media.example.com/a.mp3", idempotencyKey: "url-key-01" },
			guards,
		);

		expect(
			await createTranscriptFromUrl(
				"app-1",
				{ url: "https://media.example.com/a.mp3", idempotencyKey: KEY },
				guards,
			),
		).toMatchObject({ ok: false, status: 409, code: "idempotency_conflict" });
		expect(
			await createTranscriptFromVideo("app-1", {
				videoId: "video-1",
				idempotencyKey: "url-key-01",
			}),
		).toMatchObject({ ok: false, status: 409, code: "idempotency_conflict" });
		expect(transcripts()).toHaveLength(2);
	});

	it("still returns the transcript after the video was renamed or deleted", async () => {
		const video = seedVideo();
		const first = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});
		video.name = "Renamed";
		video.deletedAt = new Date("2026-11-12T09:00:00.000Z");

		const second = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
			idempotencyKey: KEY,
		});

		if (!first.ok || !second.ok) throw new Error("create failed");
		expect(second.transcript.id).toBe(first.transcript.id);
	});
});

describe("finding the stored file of a video", () => {
	it("returns the MP4 of the finished encode and the known duration", async () => {
		seedVideo({ duration: 95.5 });

		expect(await findVideoForTranscript("app-1", "video-1")).toEqual({
			state: "ok",
			name: "Launch walkthrough",
			sourceKey: MP4_KEY,
			durationSeconds: 95.5,
		});
	});

	it("reports no duration when the video has none", async () => {
		seedVideo({ duration: null });

		expect(await findVideoForTranscript("app-1", "video-1")).toMatchObject({
			state: "ok",
			durationSeconds: null,
		});
	});
});

describe("caption files for the playback side", () => {
	it("returns nothing for a video with no transcripts", async () => {
		expect(await developerVideoCaptions(VIDEO)).toEqual([]);
	});

	it("returns one caption file for one completed transcript", async () => {
		seedCompleted("tr-1", "hello there");

		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{ language: "en", label: "English", key: EN_KEY },
		]);
	});

	it("returns one file per language, ordered by label", async () => {
		seedCompleted("tr-1", "hello there");
		seedCompleted("tr-2", "hallo zusammen", { language: "de" });

		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{ language: "en", label: "English", key: EN_KEY },
			{ language: "de", label: "German", key: DE_KEY },
		]);
	});

	it("returns one entry for a language however many transcripts it has", async () => {
		seedCompleted("tr-old", "older words");
		seedCompleted("tr-new", "newer words");
		seedCompleted("tr-newest", "newest words");

		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{ language: "en", label: "English", key: EN_KEY },
		]);
	});

	it("leaves out transcripts that are not finished, failed, deleted, silent or for another video or app", async () => {
		seedCompleted("tr-queued", "a b", { status: "queued", language: "de" });
		seedCompleted("tr-failed", "a b", { status: "error", language: "fr" });
		seedCompleted("tr-deleted", "a b", {
			language: "es",
			deletedAt: new Date("2026-11-12T11:00:00.000Z"),
		});
		seedCompleted("tr-silent", "", { language: "it", wordCount: 0 });
		seedCompleted("tr-other-video", "a b", {
			language: "nl",
			videoId: "video-2",
		});
		seedCompleted("tr-other-app", "a b", { language: "pl", appId: "app-2" });
		seedCompleted("tr-not-video", "a b", { language: "ja", videoId: null });

		expect(await developerVideoCaptions(VIDEO)).toEqual([]);
	});

	it("labels a language it has no name for and one that was not reported", async () => {
		expect(captionLanguageLabel("sv")).toBe("Swedish");
		expect(captionLanguageLabel("und")).toBe("Captions");
		expect(captionLanguage(null)).toBe("und");
		expect(captionLanguage("../../etc")).toBe("und");
		expect(captionLanguage("EN")).toBe("en");
		expect(videoCaptionsKey(VIDEO, "../x")).toBe(
			"developer/app-1/video-1/captions/und.vtt",
		);
		seedCompleted("tr-1", "hello there", { language: null });
		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{
				language: "und",
				label: "Captions",
				key: "developer/app-1/video-1/captions/und.vtt",
			},
		]);
	});
});

describe("the caption file of a video", () => {
	const sync = (language: string | null = "en") =>
		syncVideoCaptions({ appId: "app-1", videoId: "video-1", language });

	it("is written as WebVTT from the transcript's word timings", async () => {
		seedVideo();
		seedCompleted("tr-1", "hello there");

		expect(await sync()).toEqual({ state: "written", transcriptId: "tr-1" });
		expect(context.objects.get(EN_KEY)).toBe(
			"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello there\n",
		);
		expect(context.puts).toEqual([
			{ key: EN_KEY, contentType: "text/vtt; charset=utf-8" },
		]);
	});

	it("is replaced by a newer transcript for the same video and language", async () => {
		seedVideo();
		seedCompleted("tr-old", "older words");
		await sync();
		expect(context.objects.get(EN_KEY)).toContain("older words");

		seedCompleted("tr-new", "newer words");
		expect(await sync()).toEqual({ state: "written", transcriptId: "tr-new" });
		expect(context.objects.get(EN_KEY)).toContain("newer words");
		expect(context.objects.get(EN_KEY)).not.toContain("older words");
	});

	it("is not replaced by an older transcript that finishes late", async () => {
		seedVideo();
		const old = seedCompleted("tr-old", "older words", {
			status: "processing",
		});
		seedCompleted("tr-new", "newer words");
		await sync();
		old.status = "complete";

		expect(await sync()).toEqual({ state: "written", transcriptId: "tr-new" });
		expect(context.objects.get(EN_KEY)).toContain("newer words");
	});

	it("treats a stored code with a region as one language in the list and the file", async () => {
		seedVideo();
		seedCompleted("tr-old", "older words", { language: "en_us" });
		seedCompleted("tr-new", "newer words", { language: "en-US" });
		const key = "developer/app-1/video-1/captions/en-us.vtt";

		expect(await sync("en_us")).toEqual({
			state: "written",
			transcriptId: "tr-new",
		});
		expect(context.objects.get(key)).toContain("newer words");
		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{ language: "en-us", label: "American English", key },
		]);

		await deleteTranscript("app-1", "tr-new");
		expect(context.objects.get(key)).toContain("older words");
		await deleteTranscript("app-1", "tr-old");
		expect(context.objects.has(key)).toBe(false);
	});

	it("writes a file for a transcript whose language was not reported", async () => {
		seedVideo();
		seedCompleted("tr-1", "hello there", { language: null });
		seedCompleted("tr-en", "english words");

		expect(await sync(null)).toEqual({
			state: "written",
			transcriptId: "tr-1",
		});
		expect(
			context.objects.get("developer/app-1/video-1/captions/und.vtt"),
		).toContain("hello there");
		expect(context.objects.has(EN_KEY)).toBe(false);
	});

	it("leaves another language's file alone", async () => {
		seedVideo();
		seedCompleted("tr-en", "hello there");
		seedCompleted("tr-de", "hallo zusammen", { language: "de" });
		await sync("en");
		await sync("de");

		expect(context.objects.get(EN_KEY)).toContain("hello there");
		expect(context.objects.get(DE_KEY)).toContain("hallo zusammen");
	});

	it("ends with the newest transcript when another one completes during the write", async () => {
		seedVideo();
		seedCompleted("tr-old", "older words");
		context.afterPut = () => {
			seedCompleted("tr-new", "newer words");
		};

		expect(await sync()).toEqual({ state: "written", transcriptId: "tr-new" });
		expect(context.objects.get(EN_KEY)).toContain("newer words");
	});

	it("is not written for a transcript with no speech", async () => {
		seedVideo();
		seedCompleted("tr-1", "", { wordCount: 0 });

		expect(await sync()).toEqual({ state: "removed" });
		expect(context.objects.has(EN_KEY)).toBe(false);
		expect(context.puts).toHaveLength(0);
	});

	it("is not written once the video is deleted", async () => {
		seedVideo({ deletedAt: new Date("2026-11-12T09:00:00.000Z") });
		seedCompleted("tr-1", "hello there");

		expect(await sync()).toEqual({ state: "removed" });
		expect(context.objects.has(EN_KEY)).toBe(false);
	});

	it("is removed when its transcript is deleted", async () => {
		seedVideo();
		seedCompleted("tr-1", "hello there");
		await sync();
		expect(context.objects.has(EN_KEY)).toBe(true);

		expect(await deleteTranscript("app-1", "tr-1")).toEqual({ ok: true });

		expect(context.objects.has(EN_KEY)).toBe(false);
		expect(await developerVideoCaptions(VIDEO)).toEqual([]);
	});

	it("falls back to the transcript before it when the newest one is deleted", async () => {
		seedVideo();
		seedCompleted("tr-old", "older words");
		seedCompleted("tr-new", "newer words");
		await sync();

		await deleteTranscript("app-1", "tr-new");

		expect(context.objects.get(EN_KEY)).toContain("older words");
		expect(await developerVideoCaptions(VIDEO)).toEqual([
			{ language: "en", label: "English", key: EN_KEY },
		]);
	});

	it("keeps the file when an older transcript of the same language is deleted", async () => {
		seedVideo();
		seedCompleted("tr-old", "older words");
		seedCompleted("tr-new", "newer words");
		await sync();

		await deleteTranscript("app-1", "tr-old");

		expect(context.objects.get(EN_KEY)).toContain("newer words");
	});

	it("never deletes the video's own file when a video transcript is deleted", async () => {
		seedVideo();
		context.objects.set(MP4_KEY, "mp4-bytes");
		const created = await createTranscriptFromVideo("app-1", {
			videoId: "video-1",
		});
		if (!created.ok) throw new Error("create failed");

		await deleteTranscript("app-1", created.transcript.id);

		expect(context.objects.get(MP4_KEY)).toBe("mp4-bytes");
	});
});
