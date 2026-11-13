import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	objects: new Map<string, Uint8Array>(),
	ledgerIds: 0,
	transcribe: vi.fn(),
	fetched: [] as string[],
	convertBodies: [] as string[],
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerTranscripts,
				() => ({
					status: "queued",
					sourceType: "video",
					sourceUrl: null,
					videoId: null,
					s3Key: null,
					requestedLanguage: null,
					durationSeconds: null,
					language: null,
					text: null,
					wordCount: null,
					resultKey: null,
					reservedMicroCredits: 0,
					billedMicroCredits: 0,
					errorCode: null,
					errorMessage: null,
					deletedAt: null,
				}),
			],
			[
				schema.developerVideos,
				() => ({
					name: "Untitled",
					duration: 30,
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
		context.ledgerIds += 1;
		return `ledger-${context.ledgerIds}`;
	},
	nanoIdLength: 15,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "http://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));

vi.mock("@/lib/developer-transcript-storage", () => ({
	developerObjectSize: async (key: string) =>
		context.objects.get(key)?.length ?? null,
	developerObjectUrl: async (key: string) => `http://storage.test/${key}`,
	getDeveloperObjectText: async (key: string) => {
		const bytes = context.objects.get(key);
		return bytes ? new TextDecoder().decode(bytes) : null;
	},
	putDeveloperObject: async (key: string, body: string | Uint8Array) => {
		context.objects.set(
			key,
			typeof body === "string" ? new TextEncoder().encode(body) : body,
		);
	},
	putDeveloperObjectFile: async () => {
		throw new Error("A video transcript must not copy its source");
	},
	putDeveloperObjectStream: async () => {
		throw new Error("A video transcript must not copy its source");
	},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) context.objects.delete(key);
	},
}));

vi.mock("@/lib/developer-transcript-speech", () => ({
	transcribeSpeech: context.transcribe,
	parseTranscriptLanguage: () => "auto",
}));

import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import { transcriptionMicroCredits } from "@/lib/developer-pricing";
import { developerVideoCaptions } from "@/lib/developer-video-captions";
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";
import { processingState } from "../fixtures/developer-video";

const MP4_KEY = "developer/app-1/video-1/encode-1/out-1/video.mp4";
const UPLOAD_KEY = "developer/_uploads/app-1/t-tr-1";
const RESULT_KEY = "developer/app-1/transcripts/tr-1/result.json";
const CAPTIONS_KEY = "developer/app-1/video-1/captions/en.vtt";
const FRAME_SECONDS = 1152 / 44_100;

function mp3Frames(count: number) {
	const length = Math.floor((144_000 * 128) / 44_100);
	const out = new Uint8Array(length * count);
	for (let index = 0; index < count; index++) {
		out.set([0xff, 0xfb, 9 << 4, 0x00], index * length);
	}
	return out;
}

const mp4Bytes = (size = 4_000_000) => {
	const bytes = new Uint8Array(size);
	bytes.set(new TextEncoder().encode("ftypisom"), 4);
	return bytes;
};

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const transcript = () => fake().rows(developerTranscripts)[0];
const video = () => fake().rows(developerVideos)[0];
const balance = () =>
	fake().rows(developerCreditAccounts)[0]?.balanceMicroCredits;
const ledger = () => fake().rows(developerCreditTransactions);
const run = () =>
	developerTranscribeWorkflow({ transcriptId: "tr-1", runId: "run-1" });

const speech = (text: string) => ({
	state: "ok",
	text,
	words: text.split(" ").map((word, index) => ({
		text: word,
		start: index * 500,
		end: index * 500 + 400,
		confidence: 0.9,
	})),
	language: "en",
	durationSeconds: 30,
});

beforeEach(() => {
	fake().reset();
	context.objects = new Map([[MP4_KEY, mp4Bytes()]]);
	context.ledgerIds = 0;
	context.fetched = [];
	context.convertBodies = [];
	context.transcribe.mockReset();
	context.transcribe.mockResolvedValue(speech("hello from the video"));
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 100_000,
	});
	fake().seed(developerVideos, {
		id: "video-1",
		appId: "app-1",
		playbackId: "playback-id-0123456789ab",
		processing: processingState({
			hls: { state: "complete", output: "out-1" },
			mp4: { state: "complete", output: "out-1" },
		}),
	});
	fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		runId: "run-1",
		videoId: "video-1",
		s3Key: MP4_KEY,
	});
	const audio = mp3Frames(Math.round(30 / FRAME_SECONDS));
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			context.fetched.push(url);
			if (url.startsWith("http://storage.test/")) {
				const bytes = context.objects.get(
					url.slice("http://storage.test/".length),
				);
				return bytes
					? new Response(bytes.slice(0, 1_000_000), { status: 200 })
					: new Response(null, { status: 404 });
			}
			if (url === "http://media.test/video/probe") {
				return new Response("{}", { status: 500 });
			}
			if (url === "http://media.test/audio/check") {
				return Response.json({ hasAudio: true });
			}
			if (url === "http://media.test/audio/convert") {
				context.convertBodies.push(String(init?.body ?? ""));
				return new Response(audio.slice(), { status: 200 });
			}
			throw new Error(`Unexpected fetch ${url}`);
		},
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("transcribing a stored video", () => {
	it("reads the stored MP4, charges the transcript price and writes the caption file", async () => {
		const result = await run();

		const measured = Math.round(30 / FRAME_SECONDS) * FRAME_SECONDS;
		const cost = transcriptionMicroCredits(measured);
		expect(result.success).toBe(true);
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello from the video",
			wordCount: 4,
			language: "en",
			billedMicroCredits: cost,
			reservedMicroCredits: 0,
			sourceBytes: 4_000_000,
		});
		expect(balance()).toBe(100_000 - cost);
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]).toMatchObject({ type: "transcription" });

		expect(context.convertBodies).toHaveLength(1);
		expect(context.convertBodies[0]).toContain(
			`http://storage.test/${MP4_KEY}`,
		);
		expect(
			context.fetched.every(
				(url) =>
					url.startsWith("http://storage.test/") ||
					url.startsWith("http://media.test/"),
			),
		).toBe(true);
		expect(context.objects.has(UPLOAD_KEY)).toBe(false);

		expect([...context.objects.keys()].sort()).toEqual(
			[MP4_KEY, RESULT_KEY, CAPTIONS_KEY].sort(),
		);
		const captions = new TextDecoder().decode(
			context.objects.get(CAPTIONS_KEY),
		);
		expect(captions).toBe(
			"WEBVTT\n\n00:00:00.000 --> 00:00:01.900\nhello from the video\n",
		);
		expect(
			await developerVideoCaptions({ id: "video-1", appId: "app-1" }),
		).toEqual([{ language: "en", label: "English", key: CAPTIONS_KEY }]);
	});

	it("holds for the video's known length, not for its file size", async () => {
		let held = 0;
		context.transcribe.mockImplementation(async () => {
			held = Number(transcript()?.reservedMicroCredits);
			return speech("hello");
		});
		const row = video();
		if (row) row.duration = 3600;
		context.objects.set(MP4_KEY, mp4Bytes(8_000_000));

		await run();

		expect(transcript()?.status).toBe("complete");
		expect(held).toBeGreaterThan(0);
		expect(held).toBeLessThanOrEqual(transcriptionMicroCredits(3602));
	});

	it("writes no caption file when the video has no speech and still bills it", async () => {
		context.transcribe.mockResolvedValue({ state: "no_speech" });

		const result = await run();

		expect(result.success).toBe(true);
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "",
			wordCount: 0,
		});
		expect(Number(transcript()?.billedMicroCredits)).toBeGreaterThan(0);
		expect(context.objects.has(CAPTIONS_KEY)).toBe(false);
		expect(
			await developerVideoCaptions({ id: "video-1", appId: "app-1" }),
		).toEqual([]);
	});

	it("fails without a charge when the video was deleted before the transcript ran", async () => {
		const row = video();
		if (row) row.deletedAt = new Date("2026-11-12T09:00:00.000Z");

		const result = await run();

		expect(result.success).toBe(false);
		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_missing",
			errorMessage: "The video was deleted before it could be transcribed",
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
		expect(ledger()).toHaveLength(0);
		expect(context.transcribe).not.toHaveBeenCalled();
		expect(context.objects.has(MP4_KEY)).toBe(true);
		expect(context.objects.has(CAPTIONS_KEY)).toBe(false);
	});

	it("fails without a charge when the stored file is gone", async () => {
		context.objects.delete(MP4_KEY);

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_missing",
			billedMicroCredits: 0,
		});
		expect(context.convertBodies).toHaveLength(0);
	});

	it("never deletes the video's file when the transcript fails", async () => {
		context.transcribe.mockRejectedValue(new Error("speech is down"));

		await expect(run()).rejects.toThrow("speech is down");

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "transcription_failed",
		});
		expect(context.objects.has(MP4_KEY)).toBe(true);
		expect(context.objects.has(CAPTIONS_KEY)).toBe(false);
	});

	it("fails with insufficient credits when the hold cannot be covered, and writes nothing", async () => {
		const account = fake().rows(developerCreditAccounts)[0];
		if (account) account.balanceMicroCredits = 0;

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "insufficient_credits",
		});
		expect(context.convertBodies).toHaveLength(0);
		expect(context.objects.has(CAPTIONS_KEY)).toBe(false);
	});

	it("leaves a transcript that is not from a video without a caption file", async () => {
		const row = transcript();
		if (row) {
			row.sourceType = "upload";
			row.videoId = null;
		}
		context.objects.set(UPLOAD_KEY, mp4Bytes(64_000));

		await run();

		expect(transcript()?.status).toBe("complete");
		expect(
			[...context.objects.keys()].some((key) => key.includes("/captions/")),
		).toBe(false);
	});
});
