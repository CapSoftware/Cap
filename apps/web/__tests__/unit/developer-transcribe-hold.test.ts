import { readFile } from "node:fs/promises";
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
	sleeps: [] as number[],
	onSleep: null as null | ((count: number) => void),
	publicFetch: vi.fn(),
	audioWrites: 0,
	sourceWrites: 0,
	heldAtAudioWrite: [] as number[],
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

vi.mock("workflow", () => ({
	sleep: async (duration: string | number) => {
		context.sleeps.push(Number.parseInt(String(duration), 10));
		context.onSleep?.(context.sleeps.length);
		await new Promise((resolve) => setTimeout(resolve, 0));
	},
	FatalError: class FatalError extends Error {},
	RetryableError: class RetryableError extends Error {},
}));

vi.mock("@/lib/public-media-fetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/public-media-fetch")>()),
	fetchPublicMedia: context.publicFetch,
}));

vi.mock("@/lib/developer-transcript-storage", () => {
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const chunks: Uint8Array[] = [];
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const out = new Uint8Array(
			chunks.reduce((total, chunk) => total + chunk.length, 0),
		);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	};
	return {
		developerObjectSize: async (key: string) =>
			context.objects.get(key)?.length ?? null,
		developerObjectUrl: async (key: string) => `http://storage.test/${key}`,
		getDeveloperObjectText: async (key: string) => {
			const bytes = context.objects.get(key);
			return bytes ? new TextDecoder().decode(bytes) : null;
		},
		putDeveloperObject: async (key: string, body: string | Uint8Array) => {
			if (key.endsWith("/audio.mp3")) {
				context.audioWrites += 1;
				const row = context.fake
					?.rows((await import("@cap/database/schema")).developerTranscripts)
					.find((candidate) => key.includes(`/${String(candidate.id)}/`));
				context.heldAtAudioWrite.push(Number(row?.reservedMicroCredits ?? 0));
			}
			context.objects.set(
				key,
				typeof body === "string" ? new TextEncoder().encode(body) : body,
			);
		},
		putDeveloperObjectFile: async (key: string, path: string) => {
			context.sourceWrites += 1;
			context.objects.set(key, new Uint8Array(await readFile(path)));
		},
		putDeveloperObjectStream: async (
			key: string,
			stream: ReadableStream<Uint8Array>,
		) => {
			context.sourceWrites += 1;
			context.objects.set(key, await drain(stream));
		},
		deleteDeveloperObjects: async (keys: string[]) => {
			for (const key of keys) context.objects.delete(key);
		},
	};
});

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
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";

const FOUR_HOUR_HOLD = transcriptionMicroCredits(4 * 3600);
const MINIMUM = 1_000;
const MP3_BYTES_PER_SECOND = 16_000;
const sourceKey = (id: string) => `developer/_uploads/app-1/t-${id}`;

function mp3Frames(seconds: number, bitrateIndex = 9) {
	const bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128][bitrateIndex] ?? 0;
	const length = Math.floor((144_000 * bitrate) / 44_100);
	const count = Math.round(seconds / (1152 / 44_100));
	const out = new Uint8Array(length * count);
	for (let index = 0; index < count; index++) {
		out.set([0xff, 0xfb, bitrateIndex << 4, 0x00], index * length);
	}
	return out;
}

const wav = (bytes: number) => {
	const out = new Uint8Array(bytes);
	out.set(new TextEncoder().encode("RIFF"), 0);
	out.set(new TextEncoder().encode("WAVE"), 8);
	return out;
};

const media = {
	probe: () => new Response("{}", { status: 500 }),
	convert: () => new Response(null, { status: 500 }),
	probeCalls: 0,
	convertCalls: 0,
	convertBytesPulled: 0,
	convertCancelled: false,
	storageReads: 0,
	heldAtConvert: [] as number[],
};

const endlessAudio = () => {
	const chunk = mp3Frames(1);
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			media.convertBytesPulled += chunk.length;
			controller.enqueue(chunk);
		},
		cancel() {
			media.convertCancelled = true;
		},
	});
};

const audioOf =
	(seconds: number, bitrateIndex = 9) =>
	() =>
		new Response(mp3Frames(seconds, bitrateIndex), { status: 200 });

const probing = (duration: number) => () =>
	Response.json({ metadata: { duration, width: 0, height: 0, fps: 0 } });

type CountedBody = {
	pulled: number;
	cancelled: boolean;
	stream: ReadableStream<Uint8Array>;
};

const countedBody = (bytes: number): CountedBody => {
	const body: CountedBody = {
		pulled: 0,
		cancelled: false,
		stream: new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					const left = bytes - body.pulled;
					if (left <= 0) {
						controller.close();
						return;
					}
					const chunk = wav(Math.min(left, 65_536));
					body.pulled += chunk.length;
					controller.enqueue(chunk);
				},
				cancel() {
					body.cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		),
	};
	return body;
};

const servePublic = (bytes: number, contentLength: number | null) => {
	const bodies: CountedBody[] = [];
	context.publicFetch.mockImplementation(async (url: string) => {
		const body = countedBody(bytes);
		bodies.push(body);
		return {
			response: new Response(body.stream, {
				status: 200,
				headers: { "content-type": "audio/wav" },
			}),
			finalUrl: url,
			contentLength,
		};
	});
	return bodies;
};

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const transcripts = () => fake().rows(developerTranscripts);
const transcript = (id = "tr-1") => transcripts().find((row) => row.id === id);
const account = () => fake().rows(developerCreditAccounts)[0];
const balance = () => account()?.balanceMicroCredits;
const setBalance = (value: number) => {
	const current = account();
	if (current) current.balanceMicroCredits = value;
};
const ledger = () => fake().rows(developerCreditTransactions);
const heldTotal = () =>
	transcripts()
		.filter((row) => row.status === "processing" && !row.deletedAt)
		.reduce((total, row) => total + Number(row.reservedMicroCredits), 0);
const run = (id = "tr-1") =>
	developerTranscribeWorkflow({ transcriptId: id, runId: `run-${id}` });

const addUpload = (id: string, bytes: number) => {
	context.objects.set(sourceKey(id), wav(bytes));
	return fake().seed(developerTranscripts, {
		id,
		appId: "app-1",
		runId: `run-${id}`,
		sourceBytes: bytes,
	});
};

const addUrl = (id: string) =>
	fake().seed(developerTranscripts, {
		id,
		appId: "app-1",
		runId: `run-${id}`,
		sourceType: "url",
		sourceUrl: "https://media.example.com/talk.wav",
	});

const holdElsewhere = (reservedMicroCredits: number) =>
	fake().seed(developerTranscripts, {
		id: "tr-other",
		appId: "app-1",
		runId: "run-other",
		status: "processing",
		reservedMicroCredits,
	});

const expectNoWorkDone = () => {
	expect(media.probeCalls).toBe(0);
	expect(media.convertCalls).toBe(0);
	expect(media.storageReads).toBe(0);
	expect(context.audioWrites).toBe(0);
	expect(context.transcribe).not.toHaveBeenCalled();
};

const expectRefusedForCredit = (id = "tr-1") => {
	expect(transcript(id)).toMatchObject({
		status: "error",
		errorCode: "insufficient_credits",
		reservedMicroCredits: 0,
		billedMicroCredits: 0,
		text: null,
	});
	expect(ledger()).toHaveLength(0);
};

beforeEach(() => {
	fake().reset();
	context.objects = new Map();
	context.ledgerIds = 0;
	context.sleeps = [];
	context.onSleep = null;
	context.audioWrites = 0;
	context.sourceWrites = 0;
	context.heldAtAudioWrite = [];
	context.publicFetch.mockReset();
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
	media.probeCalls = 0;
	media.convertCalls = 0;
	media.convertBytesPulled = 0;
	media.convertCancelled = false;
	media.storageReads = 0;
	media.heldAtConvert = [];
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: MINIMUM,
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("http://storage.test/")) {
			media.storageReads += 1;
			const bytes = context.objects.get(
				url.slice("http://storage.test/".length),
			);
			return bytes
				? new Response(bytes.slice(), { status: 200 })
				: new Response(null, { status: 404 });
		}
		if (url === "http://media.test/video/probe") {
			media.probeCalls += 1;
			return media.probe();
		}
		if (url === "http://media.test/audio/check") {
			return Response.json({ hasAudio: true });
		}
		if (url === "http://media.test/audio/convert") {
			media.convertCalls += 1;
			media.heldAtConvert.push(heldTotal());
			return media.convert();
		}
		throw new Error(`Unexpected fetch ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

describe("no work before a hold", () => {
	it("refuses a long upload at the minimum balance without touching the file or the farm", async () => {
		addUpload("tr-1", 10_000_000);
		media.convert = () => new Response(endlessAudio(), { status: 200 });

		await run();

		expectRefusedForCredit();
		expectNoWorkDone();
		expect(context.sleeps).toEqual([]);
		expect(balance()).toBe(MINIMUM);
		expect(transcript()?.errorMessage).toBe(
			"This transcript needs $0.40 of available credit until its audio is measured, and $0.01 is available. Add at least $0.39. Nothing was charged.",
		);
	});

	it("reads no body bytes from a URL whose size the balance cannot cover", async () => {
		addUrl("tr-1");
		const bodies = servePublic(2_000_000_000, 2_000_000_000);

		await run();

		expectRefusedForCredit();
		expectNoWorkDone();
		expect(context.publicFetch).toHaveBeenCalledTimes(1);
		expect(bodies.map((body) => body.pulled)).toEqual([0]);
		expect(bodies.map((body) => body.cancelled)).toEqual([true]);
		expect(context.sourceWrites).toBe(0);
		expect(context.objects.size).toBe(0);
	});

	it("treats a URL that does not say its size as four hours of audio", async () => {
		addUrl("tr-1");
		setBalance(FOUR_HOUR_HOLD - 1);
		const bodies = servePublic(50_000, null);

		await run();

		expectRefusedForCredit();
		expectNoWorkDone();
		expect(bodies.map((body) => body.pulled)).toEqual([0]);
		expect(bodies.map((body) => body.cancelled)).toEqual([true]);
		expect(context.sourceWrites).toBe(0);
	});

	it("downloads a URL only after its hold is recorded", async () => {
		addUrl("tr-1");
		setBalance(FOUR_HOUR_HOLD);
		const heldWhenRead: number[] = [];
		context.publicFetch.mockImplementation(async (url: string) => ({
			response: new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							heldWhenRead.push(heldTotal());
							controller.enqueue(wav(50_000));
							controller.close();
						},
					},
					{ highWaterMark: 0 },
				),
				{ status: 200 },
			),
			finalUrl: url,
			contentLength: null,
		}));
		media.convert = audioOf(30);

		await run();

		expect(heldWhenRead).toEqual([FOUR_HOUR_HOLD]);
		expect(context.sourceWrites).toBe(1);
	});

	it("still transcribes a short clip at the minimum balance and charges its measured length", async () => {
		addUpload("tr-1", 100_000);
		media.convert = audioOf(30);

		await run();

		expect(transcript()).toMatchObject({
			status: "complete",
			text: "hello world",
			reservedMicroCredits: 0,
			billedMicroCredits: 83,
		});
		expect(media.heldAtConvert).toEqual([MINIMUM]);
		expect(context.heldAtAudioWrite).toEqual([MINIMUM]);
		expect(ledger()).toHaveLength(1);
		expect(balance()).toBe(MINIMUM - 83);
		expect(context.sleeps).toEqual([]);
	});

	it("holds by the size of the file, up to four hours", async () => {
		const expected: [number, number][] = [
			[100_000, MINIMUM],
			[180_000, MINIMUM],
			[1_000_000, transcriptionMicroCredits(2_000)],
			[7_200_000, transcriptionMicroCredits(14_400)],
			[50_000_000, FOUR_HOUR_HOLD],
		];
		setBalance(1_000_000);
		media.convert = audioOf(30);
		for (const [bytes] of expected) addUpload(`tr-${bytes}`, bytes);

		for (const [bytes] of expected) await run(`tr-${bytes}`);

		expect(media.heldAtConvert).toEqual(expected.map(([, hold]) => hold));
	});
});

describe("waiting on credit that other transcripts hold", () => {
	it("waits without doing any work and runs once the other hold drops", async () => {
		setBalance(FOUR_HOUR_HOLD + 5_000);
		addUpload("tr-1", 10_000_000);
		const other = holdElsewhere(FOUR_HOUR_HOLD);
		media.convert = audioOf(30);
		const workDuringWait: number[] = [];
		context.onSleep = (count) => {
			workDuringWait.push(
				media.convertCalls + media.probeCalls + media.storageReads,
			);
			expect(transcript()).toMatchObject({
				status: "processing",
				reservedMicroCredits: 0,
			});
			if (count === 3) other.reservedMicroCredits = 100;
		};

		await run();

		expect(context.sleeps).toEqual([2, 3, 4]);
		expect(workDuringWait).toEqual([0, 0, 0]);
		expect(media.heldAtConvert).toEqual([FOUR_HOUR_HOLD + 100]);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: 83,
		});
	});

	it("gives up after about fifteen minutes and says what it needed", async () => {
		setBalance(FOUR_HOUR_HOLD + 5_000);
		addUpload("tr-1", 10_000_000);
		holdElsewhere(FOUR_HOUR_HOLD);

		await run();

		const waited = context.sleeps.reduce((total, value) => total + value, 0);
		expect(waited).toBeGreaterThanOrEqual(900);
		expect(waited).toBeLessThan(915);
		expect(Math.max(...context.sleeps)).toBe(10);
		expectRefusedForCredit();
		expectNoWorkDone();
		expect(transcript()?.errorMessage).toBe(
			"This transcript needs $0.40 of available credit until its audio is measured, and $0.05 is available. Add at least $0.35. Nothing was charged.",
		);
		expect(balance()).toBe(FOUR_HOUR_HOLD + 5_000);
	});

	it("fails at once when nothing else holds credit", async () => {
		setBalance(FOUR_HOUR_HOLD - 1);
		addUpload("tr-1", 10_000_000);

		await run();

		expect(context.sleeps).toEqual([]);
		expectRefusedForCredit();
		expectNoWorkDone();
	});

	it("asks a URL for its size once, then waits without calling it again", async () => {
		setBalance(FOUR_HOUR_HOLD + 5_000);
		addUrl("tr-1");
		const other = holdElsewhere(FOUR_HOUR_HOLD);
		const bodies = servePublic(8_000_000, 8_000_000);
		media.convert = audioOf(30);
		const fetchesDuringWait: number[] = [];
		context.onSleep = (count) => {
			fetchesDuringWait.push(context.publicFetch.mock.calls.length);
			if (count === 4) other.reservedMicroCredits = 0;
		};

		await run();

		expect(fetchesDuringWait).toEqual([1, 1, 1, 1]);
		expect(context.publicFetch).toHaveBeenCalledTimes(2);
		expect(bodies.map((body) => body.pulled)).toEqual([0, 8_000_000]);
		expect(bodies[0]?.cancelled).toBe(true);
		expect(transcript()).toMatchObject({
			status: "complete",
			sourceBytes: 8_000_000,
		});
	});

	it("raises the hold before reading when the URL later reports a larger file", async () => {
		setBalance(FOUR_HOUR_HOLD + MINIMUM);
		addUrl("tr-1");
		const other = holdElsewhere(FOUR_HOUR_HOLD);
		const sizes = [200_000, 9_000_000, 9_000_000];
		const bodies: CountedBody[] = [];
		context.publicFetch.mockImplementation(async (url: string) => {
			const size = sizes[bodies.length] ?? 0;
			const body = countedBody(size);
			bodies.push(body);
			return {
				response: new Response(body.stream, { status: 200 }),
				finalUrl: url,
				contentLength: size,
			};
		});
		context.onSleep = (count) => {
			if (count === 1) other.reservedMicroCredits = FOUR_HOUR_HOLD - MINIMUM;
		};

		await run();

		expect(context.publicFetch).toHaveBeenCalledTimes(2);
		expect(bodies.map((body) => body.pulled)).toEqual([0, 0]);
		expect(bodies.map((body) => body.cancelled)).toEqual([true, true]);
		expect(context.sourceWrites).toBe(0);
		expectRefusedForCredit();
		expectNoWorkDone();
	});

	it("stops waiting when the transcript is deleted", async () => {
		setBalance(FOUR_HOUR_HOLD + 5_000);
		addUpload("tr-1", 10_000_000);
		holdElsewhere(FOUR_HOUR_HOLD);
		context.onSleep = (count) => {
			const row = transcript();
			if (count === 2 && row) row.deletedAt = new Date();
		};

		await run();

		expect(context.sleeps).toEqual([2, 3]);
		expectNoWorkDone();
		expect(heldTotal()).toBe(FOUR_HOUR_HOLD);
	});
});

describe("audio the hold does not cover", () => {
	it("cuts off a small file that keeps producing audio at what its hold covers", async () => {
		addUpload("tr-1", 14_400);
		media.convert = () => new Response(endlessAudio(), { status: 200 });

		await run();

		expectRefusedForCredit();
		expect(media.convertCalls).toBe(1);
		expect(media.heldAtConvert).toEqual([MINIMUM]);
		expect(media.convertCancelled).toBe(true);
		expect(media.convertBytesPulled).toBeLessThanOrEqual(
			(361 + 8) * MP3_BYTES_PER_SECOND,
		);
		expect(context.audioWrites).toBe(0);
		expect(context.transcribe).not.toHaveBeenCalled();
		expect(balance()).toBe(MINIMUM);
	});

	it("does not convert at all when the file says it is longer than the hold covers", async () => {
		addUpload("tr-1", 14_400);
		media.probe = probing(4 * 3600);
		media.convert = () => new Response(endlessAudio(), { status: 200 });

		await run();

		expectRefusedForCredit();
		expect(media.convertCalls).toBe(0);
		expect(context.audioWrites).toBe(0);
	});

	it("raises the hold to the length the file reports, then converts once", async () => {
		setBalance(10_000);
		addUpload("tr-1", 100_000);
		media.probe = probing(1_000);
		media.convert = audioOf(1_000, 1);

		await run();

		expect(media.convertCalls).toBe(1);
		expect(media.heldAtConvert).toEqual([transcriptionMicroCredits(1_002)]);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: transcriptionMicroCredits(1_000),
		});
		expect(balance()).toBe(10_000 - transcriptionMicroCredits(1_000));
	});

	it("extracts again under a four hour hold when the measured audio runs past the first one", async () => {
		setBalance(FOUR_HOUR_HOLD);
		addUpload("tr-1", 100_000);
		media.convert = audioOf(1_000, 1);

		await run();

		expect(media.heldAtConvert).toEqual([MINIMUM, FOUR_HOUR_HOLD]);
		expect(context.heldAtAudioWrite).toEqual([FOUR_HOUR_HOLD]);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: transcriptionMicroCredits(1_000),
		});
	});

	it("stores no audio when the measured length is past the hold and the balance cannot raise it", async () => {
		setBalance(5_000);
		addUpload("tr-1", 100_000);
		media.convert = audioOf(1_000, 1);

		await run();

		expectRefusedForCredit();
		expect(media.convertCalls).toBe(1);
		expect(context.audioWrites).toBe(0);
		expect(context.transcribe).not.toHaveBeenCalled();
		expect(balance()).toBe(5_000);
	});

	it("waits for other holds before raising its own", async () => {
		setBalance(FOUR_HOUR_HOLD + MINIMUM);
		addUpload("tr-1", 100_000);
		const other = holdElsewhere(30_000);
		media.convert = audioOf(1_000, 1);
		context.onSleep = (count) => {
			if (count === 2) other.reservedMicroCredits = 0;
		};

		await run();

		expect(context.sleeps).toEqual([2, 3]);
		expect(media.heldAtConvert).toEqual([30_000 + MINIMUM, FOUR_HOUR_HOLD]);
		expect(transcript()?.status).toBe("complete");
	});
});

describe("a step that runs again", () => {
	it("does not extract twice once the audio is measured and the hold lowered", async () => {
		setBalance(5_000);
		const row = addUpload("tr-1", 100_000);
		Object.assign(row, {
			status: "processing",
			durationSeconds: 300,
			reservedMicroCredits: transcriptionMicroCredits(300),
		});
		context.objects.set(
			"developer/app-1/transcripts/tr-1/audio.mp3",
			mp3Frames(300, 1),
		);
		media.convert = audioOf(300, 1);

		await run();

		expect(media.convertCalls).toBe(0);
		expect(transcript()).toMatchObject({
			status: "complete",
			billedMicroCredits: transcriptionMicroCredits(300),
		});
		expect(balance()).toBe(5_000 - transcriptionMicroCredits(300));
	});
});

describe("holds are released", () => {
	it("drops the hold when the file has no audio", async () => {
		setBalance(FOUR_HOUR_HOLD);
		addUpload("tr-1", 10_000_000);
		media.convert = () => new Response(new Uint8Array(0), { status: 200 });

		await run();

		expect(media.heldAtConvert).toEqual([FOUR_HOUR_HOLD]);
		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "no_audio_track",
			reservedMicroCredits: 0,
		});
		expect(heldTotal()).toBe(0);
		expect(balance()).toBe(FOUR_HOUR_HOLD);
	});

	it("drops the hold when a download fails", async () => {
		setBalance(FOUR_HOUR_HOLD);
		addUrl("tr-1");
		context.publicFetch.mockImplementation(async (url: string) => ({
			response: new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(new Error("connection reset"));
					},
				}),
				{ status: 200 },
			),
			finalUrl: url,
			contentLength: 9_000_000,
		}));

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_unreachable",
			reservedMicroCredits: 0,
		});
		expect(heldTotal()).toBe(0);
	});

	it("never lets two transcripts hold the same credit", async () => {
		setBalance(FOUR_HOUR_HOLD + 500);
		addUpload("tr-1", 10_000_000);
		addUpload("tr-2", 10_000_000);
		media.convert = audioOf(30);
		const heldSeen: number[] = [];
		context.onSleep = () => heldSeen.push(heldTotal());

		await Promise.all([run("tr-1"), run("tr-2")]);

		expect(Math.max(...media.heldAtConvert)).toBeLessThanOrEqual(
			FOUR_HOUR_HOLD + 500,
		);
		expect(Math.max(...heldSeen)).toBeLessThanOrEqual(FOUR_HOUR_HOLD + 500);
		expect(context.sleeps.length).toBeGreaterThan(0);
		expect(transcript("tr-1")?.status).toBe("complete");
		expect(transcript("tr-2")?.status).toBe("complete");
		expect(balance()).toBe(FOUR_HOUR_HOLD + 500 - 2 * 83);
	});
});
