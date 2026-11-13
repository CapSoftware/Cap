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
		failNextCommit: () => void;
	},
	objects: new Map<string, Uint8Array>(),
	ledgerIds: 0,
	transcribe: vi.fn(),
	measured: null as number | null,
	writes: new Map<string, number>(),
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
					requestedLanguage: null,
					durationSeconds: null,
					text: null,
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
	serverEnv: () => ({
		MEDIA_SERVER_URL: "http://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
}));

vi.mock("@/lib/mp3-duration", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/mp3-duration")>();
	return {
		measureMp3DurationSeconds: (audio: Uint8Array) =>
			context.measured ?? actual.measureMp3DurationSeconds(audio),
	};
});

vi.mock("@/lib/developer-transcript-storage", () => ({
	developerObjectSize: async (key: string) =>
		context.objects.get(key)?.length ?? null,
	developerObjectUrl: async (key: string) => `http://storage.test/${key}`,
	getDeveloperObjectText: async (key: string) => {
		const bytes = context.objects.get(key);
		return bytes ? new TextDecoder().decode(bytes) : null;
	},
	putDeveloperObject: async (key: string, body: string | Uint8Array) => {
		context.writes.set(key, (context.writes.get(key) ?? 0) + 1);
		context.objects.set(
			key,
			typeof body === "string" ? new TextEncoder().encode(body) : body,
		);
	},
	putDeveloperObjectFile: async () => {},
	putDeveloperObjectStream: async () => {},
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
} from "@cap/database/schema";
import { transcriptionMicroCredits } from "@/lib/developer-pricing";
import {
	developerTranscribeWorkflow,
	FAST_PATH_BUDGET_MS,
	FAST_PATH_MAX_AUDIO_SECONDS,
	runTranscriptFastPath,
} from "@/workflows/developer-transcribe";

const SOURCE_KEY = "developer/_uploads/app-1/t-tr-1";
const AUDIO_KEY = "developer/app-1/transcripts/tr-1/audio.mp3";
const RESULT_KEY = "developer/app-1/transcripts/tr-1/result.json";
const FRAME_SECONDS = 1152 / 44_100;

function mp3Frames(count: number, bitrateIndex = 9) {
	const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128][bitrateIndex] ?? 0;
	const length = Math.floor((144_000 * bitrate) / 44_100);
	const out = new Uint8Array(length * count);
	for (let index = 0; index < count; index++) {
		out.set([0xff, 0xfb, bitrateIndex << 4, 0x00], index * length);
	}
	return out;
}

const wavHeader = () => {
	const bytes = new Uint8Array(64);
	bytes.set(new TextEncoder().encode("RIFF"), 0);
	bytes.set(new TextEncoder().encode("WAVE"), 8);
	return bytes;
};

type Media = {
	probe: () => Response;
	convert: () => Response;
	check: () => Response;
	convertCalls: number;
	convertBytesPulled: number;
	convertCancelled: boolean;
};

const media: Media = {
	probe: () => new Response("{}", { status: 500 }),
	convert: () => new Response(null, { status: 500 }),
	check: () => Response.json({ hasAudio: true }),
	convertCalls: 0,
	convertBytesPulled: 0,
	convertCancelled: false,
};

const streamOf = (chunk: Uint8Array, chunks: number) => {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent += 1;
			media.convertBytesPulled += chunk.length;
			controller.enqueue(chunk);
		},
		cancel() {
			media.convertCancelled = true;
		},
	});
};

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const transcript = () => fake().rows(developerTranscripts)[0];
const balance = () =>
	fake().rows(developerCreditAccounts)[0]?.balanceMicroCredits;
const ledger = () => fake().rows(developerCreditTransactions);
const run = () =>
	developerTranscribeWorkflow({ transcriptId: "tr-1", runId: "run-1" });

beforeEach(() => {
	fake().reset();
	context.objects = new Map([[SOURCE_KEY, wavHeader()]]);
	context.ledgerIds = 0;
	context.measured = null;
	context.writes = new Map();
	context.transcribe.mockReset();
	context.transcribe.mockResolvedValue({
		state: "ok",
		text: "hello world",
		words: [
			{ text: "hello", start: 0, end: 400, confidence: 0.9 },
			{ text: "world", start: 450, end: 900, confidence: 0.9 },
		],
		language: "en",
		durationSeconds: 30,
	});
	media.probe = () => new Response("{}", { status: 500 });
	media.convert = () => new Response(null, { status: 500 });
	media.check = () => Response.json({ hasAudio: true });
	media.convertCalls = 0;
	media.convertBytesPulled = 0;
	media.convertCancelled = false;
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 100_000,
	});
	fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		runId: "run-1",
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("http://storage.test/")) {
			const bytes = context.objects.get(
				url.slice("http://storage.test/".length),
			);
			return bytes
				? new Response(bytes.slice(), { status: 200 })
				: new Response(null, { status: 404 });
		}
		if (url === "http://media.test/video/probe") return media.probe();
		if (url === "http://media.test/audio/check") return media.check();
		if (url === "http://media.test/audio/convert") {
			media.convertCalls += 1;
			return media.convert();
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

const thirtySeconds = () => {
	const frames = Math.round(30 / FRAME_SECONDS);
	media.convert = () =>
		new Response(streamOf(mp3Frames(frames), 1), { status: 200 });
	return transcriptionMicroCredits(frames * FRAME_SECONDS);
};

const fast = () => runTranscriptFastPath("tr-1", "run-1");

const failSettleOnce = () => {
	const answer = context.transcribe.getMockImplementation();
	context.transcribe.mockImplementationOnce(async (...args: unknown[]) => {
		fake().failNextCommit();
		return answer ? answer(...args) : undefined;
	});
};

const longSource = () => {
	const bytes = new Uint8Array(1024 * 1024);
	bytes.set(wavHeader());
	context.objects.set(SOURCE_KEY, bytes);
	const account = fake().rows(developerCreditAccounts)[0];
	if (account) account.balanceMicroCredits = 1_000_000;
};

describe("the fast path", () => {
	it("completes a short file in one step: claimed, held, extracted, transcribed and charged", async () => {
		const cost = thirtySeconds();

		const result = await fast();

		expect(result).toMatchObject({ resume: "done", settlement: "complete" });
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello world",
			billedMicroCredits: cost,
			reservedMicroCredits: 0,
			wordCount: 2,
		});
		expect(balance()).toBe(100_000 - cost);
		expect(ledger()).toHaveLength(1);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(media.convertCalls).toBe(1);
	});

	it("hands the audio to speech recognition without reading it back from storage", async () => {
		thirtySeconds();
		const reads: string[] = [];
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			reads.push(String(input));
			return realFetch(input);
		});

		await fast();

		expect(reads.filter((url) => url.endsWith(AUDIO_KEY))).toEqual([]);
		expect(context.objects.has(AUDIO_KEY)).toBe(true);
	});

	it("leaves nothing for the rest of the workflow to redo", async () => {
		const cost = thirtySeconds();

		const result = await run();

		expect(result).toEqual({ success: true, message: "Transcript completed" });
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(media.convertCalls).toBe(1);
		expect(context.writes.get(RESULT_KEY)).toBe(1);
		expect(context.writes.get(AUDIO_KEY)).toBe(1);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(100_000 - cost);
		expect([...context.objects.keys()]).toEqual([RESULT_KEY]);
	});

	it("does not charge, transcribe or write twice when the whole step runs again", async () => {
		const cost = thirtySeconds();

		const first = await fast();
		const second = await fast();

		expect(first).toMatchObject({ resume: "done", settlement: "complete" });
		expect(second).toEqual({ resume: "unclaimed" });
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(context.writes.get(RESULT_KEY)).toBe(1);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(100_000 - cost);
	});

	it("does not transcribe or charge twice when it runs again after the settle failed", async () => {
		const cost = thirtySeconds();
		failSettleOnce();

		const first = await fast();
		expect(first).toMatchObject({ resume: "settle" });
		expect(transcript()?.status).toBe("processing");
		expect(ledger()).toHaveLength(0);

		const second = await fast();

		expect(second).toMatchObject({ resume: "done", settlement: "complete" });
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(context.writes.get(RESULT_KEY)).toBe(1);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(100_000 - cost);
	});

	it("is finished step by step when its settle fails, with one charge", async () => {
		const cost = thirtySeconds();
		failSettleOnce();

		const result = await run();

		expect(result.success).toBe(true);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(100_000 - cost);
	});

	it("hands a long recording to its own transcription step", async () => {
		thirtySeconds();
		context.measured = FAST_PATH_MAX_AUDIO_SECONDS + 1;
		longSource();

		const result = await fast();

		expect(result).toEqual({ resume: "transcribe" });
		expect(context.transcribe).not.toHaveBeenCalled();
		expect(transcript()).toMatchObject({
			status: "processing",
			durationSeconds: FAST_PATH_MAX_AUDIO_SECONDS + 1,
		});

		const finished = await run();
		expect(finished).toEqual({
			success: true,
			message: "Transcript completed",
		});
		expect(media.convertCalls).toBe(1);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(ledger()).toHaveLength(1);
	});

	it("finishes a long recording through the separate step with the same charge", async () => {
		thirtySeconds();
		context.measured = FAST_PATH_MAX_AUDIO_SECONDS + 1;
		longSource();

		const result = await run();

		expect(result.success).toBe(true);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: transcriptionMicroCredits(
				FAST_PATH_MAX_AUDIO_SECONDS + 1,
			),
		});
		expect(ledger()).toHaveLength(1);
	});

	it("hands extraction to its own step when getting the file took most of the budget", async () => {
		thirtySeconds();
		let calls = 0;
		const clock = vi
			.spyOn(performance, "now")
			.mockImplementation(() => (calls++ === 0 ? 0 : FAST_PATH_BUDGET_MS + 1));

		const result = await fast();
		clock.mockRestore();

		expect(result).toEqual({ resume: "extract", audio: null });
		expect(media.convertCalls).toBe(0);
		expect(Number(transcript()?.reservedMicroCredits)).toBeGreaterThan(0);

		expect((await run()).success).toBe(true);
		expect(media.convertCalls).toBe(1);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect(ledger()).toHaveLength(1);
	});

	it("hands transcription to its own step when extraction took most of the budget", async () => {
		thirtySeconds();
		let calls = 0;
		const clock = vi
			.spyOn(performance, "now")
			.mockImplementation(() => (calls++ < 2 ? 0 : FAST_PATH_BUDGET_MS + 1));

		const result = await fast();
		clock.mockRestore();

		expect(result).toEqual({ resume: "transcribe" });
		expect(media.convertCalls).toBe(1);
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("hands over at the hold when another transcript holds the credit", async () => {
		thirtySeconds();
		fake().seed(developerTranscripts, {
			id: "tr-other",
			appId: "app-1",
			status: "processing",
			reservedMicroCredits: 99_500,
		});

		const result = await fast();

		expect(result).toMatchObject({
			resume: "prepare",
			source: { ok: false, wait: true },
		});
		expect(media.convertCalls).toBe(0);
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("hands over to the hold raise when the audio is longer than its file suggested", async () => {
		const frames = Math.round(30 / FRAME_SECONDS);
		media.probe = () =>
			Response.json({
				metadata: { duration: 3 * 3600, width: 1, height: 1 },
			});
		media.convert = () =>
			new Response(streamOf(mp3Frames(frames), 1), { status: 200 });

		const result = await fast();

		expect(result).toMatchObject({
			resume: "extract",
			audio: { ok: false, raise: true, reportedSeconds: 3 * 3600 },
		});
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("keeps the failure code and message of a file it cannot use", async () => {
		context.objects.set(
			SOURCE_KEY,
			new TextEncoder().encode("#EXTM3U\nhttp://127.0.0.1/secret.ts\n"),
		);

		const result = await run();

		expect(result).toEqual({
			success: false,
			message: "The file is not a supported audio or video format",
		});
		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "unsupported_format",
			errorMessage: "The file is not a supported audio or video format",
			billedMicroCredits: 0,
		});
	});

	it("keeps the failure code when speech recognition keeps failing", async () => {
		thirtySeconds();
		context.transcribe.mockRejectedValue(new Error("speech is down"));

		await expect(run()).rejects.toThrow("speech is down");

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "transcription_failed",
			errorMessage: "The transcript could not be created",
			billedMicroCredits: 0,
		});
		expect(ledger()).toHaveLength(0);
	});

	it("does nothing for a run that no longer owns the transcript", async () => {
		const row = transcript();
		if (row) row.runId = "run-2";

		expect(await fast()).toEqual({ resume: "unclaimed" });
		expect(media.convertCalls).toBe(0);
	});
});
