import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LIMIT_SECONDS = 60;

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

vi.mock("@/lib/developer-transcripts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/developer-transcripts")>()),
	TRANSCRIPT_MAX_DURATION_SECONDS: 60,
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
import { TRANSCRIPT_AUDIO_MAX_BYTES } from "@/lib/developer-transcript-audio";
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";

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

const expectRefusedAsTooLong = () => {
	expect(transcript()).toMatchObject({
		status: "error",
		errorCode: "duration_too_long",
		reservedMicroCredits: 0,
		billedMicroCredits: 0,
		text: null,
	});
	expect(balance()).toBe(100_000);
	expect(ledger()).toHaveLength(0);
	expect(context.transcribe).not.toHaveBeenCalled();
	expect([...context.objects.keys()]).toEqual([]);
};

describe("developer transcribe workflow", () => {
	it("transcribes, charges the measured length once and keeps only the result", async () => {
		const frames = Math.round(30 / FRAME_SECONDS);
		const audio = mp3Frames(frames);
		media.convert = () => new Response(streamOf(audio, 1), { status: 200 });

		const result = await run();

		const measured = frames * FRAME_SECONDS;
		const cost = transcriptionMicroCredits(measured);
		expect(result.success).toBe(true);
		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello world",
			billedMicroCredits: cost,
			reservedMicroCredits: 0,
			wordCount: 2,
		});
		expect(Number(transcript()?.durationSeconds)).toBeCloseTo(measured, 6);
		expect(balance()).toBe(100_000 - cost);
		expect(ledger()).toHaveLength(1);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
		expect((context.transcribe.mock.calls[0]?.[0] as Buffer).length).toBe(
			audio.length,
		);
		expect([...context.objects.keys()]).toEqual([RESULT_KEY]);

		const again = await run();
		expect(again.message).toBe("Transcript is not waiting to run");
		expect(ledger()).toHaveLength(1);
		expect(context.transcribe).toHaveBeenCalledTimes(1);
	});

	it("stops an extraction that keeps producing audio and fails it as too long", async () => {
		const chunk = mp3Frames(100);
		media.convert = () =>
			new Response(streamOf(chunk, Number.POSITIVE_INFINITY), { status: 200 });

		const result = await run();

		expect(result.success).toBe(false);
		expectRefusedAsTooLong();
		expect(media.convertCancelled).toBe(true);
		expect(media.convertBytesPulled).toBeGreaterThan(
			TRANSCRIPT_AUDIO_MAX_BYTES,
		);
		expect(media.convertBytesPulled).toBeLessThanOrEqual(
			TRANSCRIPT_AUDIO_MAX_BYTES + 8 * chunk.length,
		);
		expect(TRANSCRIPT_AUDIO_MAX_BYTES).toBe((LIMIT_SECONDS + 2) * 16_000);
	});

	it("refuses a source whose probed length is over the limit before converting", async () => {
		media.probe = () =>
			Response.json({
				metadata: { duration: 4.5 * 3600, width: 1, height: 1 },
			});
		media.convert = () =>
			new Response(streamOf(mp3Frames(10), 1), { status: 200 });

		await run();

		expectRefusedAsTooLong();
		expect(media.convertCalls).toBe(0);
	});

	it("refuses low bitrate audio that fits the byte cap but runs over the limit", async () => {
		const frames = Math.ceil((LIMIT_SECONDS + 3) / FRAME_SECONDS);
		const audio = mp3Frames(frames, 1);
		expect(audio.length).toBeLessThan(TRANSCRIPT_AUDIO_MAX_BYTES);
		media.convert = () => new Response(streamOf(audio, 1), { status: 200 });

		await run();

		expectRefusedAsTooLong();
	});

	it("accepts audio right at the limit", async () => {
		const frames = Math.floor(LIMIT_SECONDS / FRAME_SECONDS);
		media.convert = () =>
			new Response(streamOf(mp3Frames(frames), 1), { status: 200 });

		await run();

		expect(transcript()?.status).toBe("complete");
		expect(ledger()).toHaveLength(1);
	});

	it("reports a file without an audio track and charges nothing", async () => {
		media.convert = () =>
			Response.json({ error: "No audio", code: "FAILED" }, { status: 500 });
		media.check = () => Response.json({ hasAudio: false });

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "no_audio_track",
		});
		expect(ledger()).toHaveLength(0);
		expect(context.transcribe).not.toHaveBeenCalled();
	});

	it("refuses a playlist before anything is extracted", async () => {
		context.objects.set(
			SOURCE_KEY,
			new TextEncoder().encode("#EXTM3U\nhttp://127.0.0.1/secret.ts\n"),
		);

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "unsupported_format",
		});
		expect(media.convertCalls).toBe(0);
	});

	it("does nothing for a run that no longer owns the transcript", async () => {
		const row = transcript();
		if (row) row.runId = "run-2";
		media.convert = () =>
			new Response(streamOf(mp3Frames(100), 1), { status: 200 });

		const result = await run();

		expect(result.message).toBe("Transcript is not waiting to run");
		expect(transcript()).toMatchObject({ status: "queued", runId: "run-2" });
		expect(media.convertCalls).toBe(0);
		expect(context.objects.has(SOURCE_KEY)).toBe(true);
		expect(context.objects.has(AUDIO_KEY)).toBe(false);
	});
});
