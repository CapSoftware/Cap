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
	objects: new Map<string, Uint8Array>(),
	sourceSizes: new Map<string, number>(),
	ledgerIds: 0,
	transcribe: vi.fn(),
	extract: vi.fn(),
	publicFetch: vi.fn(),
	selfContained: true,
	heldAtExtract: [] as number[],
	heldAtSpeech: [] as number[],
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
					sourceType: "upload",
					sourceUrl: null,
					sourceBytes: null,
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
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));

vi.mock("workflow", () => ({
	sleep: async () => {},
	FatalError: class FatalError extends Error {},
	RetryableError: class RetryableError extends Error {},
}));

vi.mock("@/lib/public-media-fetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/public-media-fetch")>()),
	fetchPublicMedia: context.publicFetch,
}));

vi.mock("@/lib/media-container", () => ({
	urlIsSelfContainedMedia: async () => context.selfContained,
}));

vi.mock("@/lib/storage-fetch", () => ({
	fetchStorageUrl: async (url: string) => {
		const bytes = context.objects.get(url.slice("http://storage.test/".length));
		return bytes
			? new Response(bytes.slice(), { status: 200 })
			: new Response(null, { status: 404 });
	},
}));

vi.mock("@/lib/mp3-duration", () => ({
	measureMp3DurationSeconds: (audio: Buffer) => audio.readDoubleBE(0),
}));

vi.mock("@/lib/developer-transcript-audio", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/developer-transcript-audio")
	>()),
	extractTranscriptAudioBytes: context.extract,
}));

vi.mock("@/lib/developer-transcript-storage", () => ({
	developerObjectSize: async (key: string) =>
		context.sourceSizes.get(key) ?? context.objects.get(key)?.length ?? null,
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
	putDeveloperObjectFile: async () => {},
	putDeveloperObjectStream: async () => {},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) {
			context.objects.delete(key);
			context.sourceSizes.delete(key);
		}
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
} from "@cap/database/schema";
import { transcriptionMicroCredits } from "@/lib/developer-pricing";
import { settleTranscript } from "@/lib/developer-transcript-billing";
import type { TranscriptResultObject } from "@/lib/developer-transcripts";
import { PublicMediaFetchError } from "@/lib/public-media-fetch";
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";

const SOURCE_KEY = "developer/_uploads/app-1/t-tr-1";
const AUDIO_KEY = "developer/app-1/transcripts/tr-1/audio.mp3";
const RESULT_KEY = "developer/app-1/transcripts/tr-1/result.json";
const START_BALANCE = 100_000;
const NO_SPEECH = { state: "no_speech" as const };

const audioOf = (seconds: number) => {
	const audio = Buffer.alloc(64);
	audio.writeDoubleBE(seconds, 0);
	return audio;
};

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const transcript = () => fake().rows(developerTranscripts)[0];
const account = () => fake().rows(developerCreditAccounts)[0];
const balance = () => account()?.balanceMicroCredits;
const setBalance = (value: number) => {
	const current = account();
	if (current) current.balanceMicroCredits = value;
};
const ledger = () => fake().rows(developerCreditTransactions);
const held = () => Number(transcript()?.reservedMicroCredits ?? 0);
const storedResult = () =>
	JSON.parse(
		new TextDecoder().decode(context.objects.get(RESULT_KEY)),
	) as TranscriptResultObject;
const run = () =>
	developerTranscribeWorkflow({ transcriptId: "tr-1", runId: "run-1" });

const upload = (bytes: number, row: Record<string, unknown> = {}) => {
	context.sourceSizes.set(SOURCE_KEY, bytes);
	return fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		runId: "run-1",
		sourceBytes: bytes,
		...row,
	});
};

const fromUrl = () =>
	fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		runId: "run-1",
		sourceType: "url",
		sourceUrl: "https://media.example.com/talk.wav",
	});

const audioIs = (seconds: number) =>
	context.extract.mockImplementation(async () => {
		context.heldAtExtract.push(held());
		return { state: "ok", audio: audioOf(seconds) };
	});

const speechIs = (result: unknown) =>
	context.transcribe.mockImplementation(async () => {
		context.heldAtSpeech.push(held());
		return result;
	});

const expectFreeFailure = (code: string) => {
	expect(transcript()).toMatchObject({
		status: "error",
		errorCode: code,
		reservedMicroCredits: 0,
		billedMicroCredits: 0,
		text: null,
	});
	expect(ledger()).toHaveLength(0);
	expect(balance()).toBe(START_BALANCE);
	expect([...context.objects.keys()]).toEqual([]);
};

beforeEach(() => {
	fake().reset();
	context.objects = new Map();
	context.sourceSizes = new Map();
	context.ledgerIds = 0;
	context.selfContained = true;
	context.heldAtExtract = [];
	context.heldAtSpeech = [];
	context.extract.mockReset();
	context.transcribe.mockReset();
	context.publicFetch.mockReset();
	audioIs(600);
	speechIs({
		state: "ok",
		text: "hello world",
		words: [
			{ text: "hello", start: 0, end: 400, confidence: 0.9 },
			{ text: "world", start: 450, end: 900, confidence: 0.9 },
		],
		language: "en",
		durationSeconds: 600,
	});
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: START_BALANCE,
	});
});

describe("audio with no speech", () => {
	const COST = transcriptionMicroCredits(600);

	it("completes with empty text and is billed for the measured audio", async () => {
		upload(10_000_000);
		speechIs(NO_SPEECH);

		const result = await run();

		expect(result.success).toBe(true);
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "",
			wordCount: 0,
			language: null,
			durationSeconds: 600,
			billedMicroCredits: COST,
			reservedMicroCredits: 0,
			errorCode: null,
			errorMessage: null,
			resultKey: RESULT_KEY,
		});
		expect(ledger()).toEqual([
			expect.objectContaining({
				type: "transcription",
				amountMicroCredits: -COST,
				balanceAfterMicroCredits: START_BALANCE - COST,
				referenceId: "tr-1",
				referenceType: "developer_transcript",
			}),
		]);
		expect(balance()).toBe(START_BALANCE - COST);
		expect(storedResult()).toEqual({
			text: "",
			language: null,
			durationSeconds: 600,
			words: [],
			segments: [],
		});
		expect([...context.objects.keys()]).toEqual([RESULT_KEY]);
	});

	it("treats an empty result from the speech service the same way and keeps a detected language", async () => {
		upload(10_000_000);
		speechIs({
			state: "ok",
			text: "  ",
			words: [],
			language: "de",
			durationSeconds: 599.4,
		});

		await run();

		expect(transcript()).toMatchObject({
			status: "complete",
			text: "",
			wordCount: 0,
			language: "de",
			billedMicroCredits: COST,
		});
		expect(ledger()).toHaveLength(1);
	});

	it("lowers a hold that is larger than the cost before speech runs and releases it on completion", async () => {
		upload(10_000_000);
		speechIs(NO_SPEECH);

		await run();

		expect(context.heldAtExtract).toEqual([40_000]);
		expect(context.heldAtSpeech).toEqual([COST]);
		expect(held()).toBe(0);
		expect(balance()).toBe(START_BALANCE - COST);
	});

	it("is not billed again by a repeat delivery or a second settle", async () => {
		upload(10_000_000);
		speechIs(NO_SPEECH);
		await run();

		const again = await run();
		const resettled = await settleTranscript({
			transcriptId: "tr-1",
			durationSeconds: 600,
			language: null,
			text: "",
			wordCount: 0,
			resultKey: RESULT_KEY,
		});

		expect(again.message).toBe("Transcript is not waiting to run");
		expect(resettled).toEqual({
			state: "complete",
			chargedMicroCredits: 0,
			alreadySettled: true,
		});
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(START_BALANCE - COST);
	});

	it("does not send the audio to speech again when its steps run again after the empty result was stored", async () => {
		upload(10_000_000, { durationSeconds: 600, reservedMicroCredits: COST });
		context.objects.set(AUDIO_KEY, audioOf(600));
		context.objects.set(
			RESULT_KEY,
			new TextEncoder().encode(
				JSON.stringify({
					text: "",
					language: null,
					durationSeconds: 600,
					words: [],
					segments: [],
				}),
			),
		);

		await run();

		expect(context.extract).not.toHaveBeenCalled();
		expect(context.transcribe).not.toHaveBeenCalled();
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "",
			wordCount: 0,
			billedMicroCredits: COST,
		});
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(START_BALANCE - COST);
	});

	it("ends as insufficient credits, with nothing charged, when the balance can no longer pay the measured cost", async () => {
		upload(10_000_000);
		context.transcribe.mockImplementation(async () => {
			setBalance(COST - 1);
			return NO_SPEECH;
		});

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "insufficient_credits",
			text: null,
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
		expect(ledger()).toHaveLength(0);
		expect(balance()).toBe(COST - 1);
		expect([...context.objects.keys()]).toEqual([]);
	});

	it("still charges a transcript with speech exactly as before", async () => {
		upload(10_000_000);

		await run();

		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello world",
			wordCount: 2,
			language: "en",
			billedMicroCredits: COST,
		});
		expect(balance()).toBe(START_BALANCE - COST);
	});

	it("counts words from the text when the service returns text without word timings", async () => {
		upload(10_000_000);
		speechIs({
			state: "ok",
			text: "three short words",
			words: [],
			language: "en",
			durationSeconds: 600,
		});

		await run();

		expect(transcript()).toMatchObject({
			status: "complete",
			text: "three short words",
			wordCount: 3,
		});
	});
});

describe("failures that stay free", () => {
	it("unsupported_format: the file is not audio or video", async () => {
		upload(10_000_000);
		context.selfContained = false;

		await run();

		expectFreeFailure("unsupported_format");
		expect(context.extract).not.toHaveBeenCalled();
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("no_audio_track: the file has no audio", async () => {
		upload(10_000_000);
		context.extract.mockResolvedValue({ state: "no_audio" });

		await run();

		expectFreeFailure("no_audio_track");
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("duration_too_long: the audio is over four hours", async () => {
		upload(10_000_000);
		context.extract.mockResolvedValue({ state: "too_long" });

		await run();

		expectFreeFailure("duration_too_long");
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("source_missing: the uploaded file is not in storage", async () => {
		upload(10_000_000);
		context.sourceSizes.clear();

		await run();

		expectFreeFailure("source_missing");
	});

	it("source_too_large: the file is over 2 GB", async () => {
		upload(2 * 1024 ** 3 + 1);

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_too_large",
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
		expect(ledger()).toHaveLength(0);
		expect(balance()).toBe(START_BALANCE);
		expect(context.extract).not.toHaveBeenCalled();
	});

	it("source_unreachable: the URL does not answer with the file", async () => {
		fromUrl();
		context.publicFetch.mockRejectedValue(
			new PublicMediaFetchError("bad_status", "The URL answered 404"),
		);

		await run();

		expectFreeFailure("source_unreachable");
	});

	it("source_blocked: the URL points to a private address", async () => {
		fromUrl();
		context.publicFetch.mockRejectedValue(
			new PublicMediaFetchError(
				"private_address",
				"The URL must point to a public address",
			),
		);

		await run();

		expectFreeFailure("source_blocked");
	});

	it("insufficient_credits: the balance cannot cover the hold", async () => {
		upload(10_000_000);
		setBalance(1_000);

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "insufficient_credits",
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
		expect(ledger()).toHaveLength(0);
		expect(balance()).toBe(1_000);
		expect(context.extract).not.toHaveBeenCalled();
	});

	it("transcription_failed: the speech service fails after the audio was extracted", async () => {
		upload(10_000_000);
		context.transcribe.mockRejectedValue(
			new Error("Speech service failed: internal error"),
		);

		await expect(run()).rejects.toThrow("Speech service failed");

		expectFreeFailure("transcription_failed");
		expect(context.extract).toHaveBeenCalledTimes(1);
	});

	it("transcription_failed: the audio extraction fails on our side", async () => {
		upload(10_000_000);
		context.extract.mockRejectedValue(new Error("Server is busy"));

		await expect(run()).rejects.toThrow("Server is busy");

		expectFreeFailure("transcription_failed");
		expect(context.transcribe).not.toHaveBeenCalled();
	});
});
