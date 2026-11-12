import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
	origin: "",
	fetchedUrls: [] as string[],
	streamedPuts: 0,
	filePuts: [] as { at: number; bytes: number }[],
	filePutFails: false,
	slowBodyLimitMs: 150,
	extract: vi.fn(),
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
					sourceType: "url",
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

vi.mock("@/lib/developer-transcripts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/developer-transcripts")>()),
	TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS: 2_000,
}));

vi.mock("@/lib/public-media-fetch", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/public-media-fetch")>();
	const { requestPublicOnly } = await import("@/lib/storage-fetch");
	return {
		...actual,
		fetchPublicMedia: async (
			url: string,
			options: { signal?: AbortSignal },
		) => {
			context.fetchedUrls.push(url);
			const response = await requestPublicOnly(
				`${context.origin}${new URL(url).pathname}`,
				{ signal: options.signal },
			);
			const declared = Number(response.headers.get("content-length"));
			return {
				response,
				finalUrl: url,
				contentLength:
					response.headers.has("content-length") && Number.isFinite(declared)
						? declared
						: null,
			};
		},
	};
});

vi.mock("@/lib/media-container", () => ({
	urlIsSelfContainedMedia: async () => true,
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

vi.mock("@/lib/developer-transcript-speech", () => ({
	transcribeSpeech: async () => ({
		state: "ok",
		text: "hello world",
		words: [],
		language: "en",
		durationSeconds: 30,
	}),
	parseTranscriptLanguage: () => "auto",
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
	putDeveloperObjectStream: async (
		key: string,
		body: ReadableStream<Uint8Array>,
	) => {
		context.streamedPuts += 1;
		const chunks: Uint8Array[] = [];
		const reader = body.getReader();
		const refuse = new Promise<never>((_resolve, reject) =>
			setTimeout(
				() =>
					reject(
						new Error("the store closed a request body that was too slow"),
					),
				context.slowBodyLimitMs,
			),
		);
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), refuse]);
			if (done) break;
			chunks.push(value);
		}
		context.objects.set(key, Buffer.concat(chunks));
	},
	putDeveloperObjectFile: async (key: string, path: string, bytes: number) => {
		if (context.filePutFails) throw new Error("storage is unavailable");
		context.filePuts.push({ at: Date.now(), bytes });
		context.objects.set(key, new Uint8Array(await readFile(path)));
	},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) context.objects.delete(key);
	},
}));

vi.mock("@/lib/storage-fetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/storage-fetch")>()),
	fetchStorageUrl: async (url: string) => {
		const bytes = context.objects.get(url.slice("http://storage.test/".length));
		return bytes
			? new Response(bytes.slice(), { status: 200 })
			: new Response(null, { status: 404 });
	},
}));

import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
} from "@cap/database/schema";
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";

const SOURCE_KEY = "developer/_uploads/app-1/t-tr-1";
const SIGNED_URL = "https://media.example.com/clip.mp3?sig=secret&expires=1";

type Origin = {
	server: Server;
	finishedAt: number | null;
	closedEarly: boolean;
	served: number;
};

let origin: Origin | null = null;

const serve = async (options: {
	bytes: number;
	chunks: number;
	everyMs: number;
	contentLength: boolean;
	stopAfterChunks?: number;
}) => {
	const state: Origin = {
		server: createServer((_request, response) => {
			response.writeHead(200, {
				"content-type": "audio/mpeg",
				...(options.contentLength
					? { "content-length": String(options.bytes) }
					: {}),
			});
			const size = Math.ceil(options.bytes / options.chunks);
			let sent = 0;
			let chunk = 0;
			const tick = () => {
				if (response.destroyed) return;
				if (chunk === options.stopAfterChunks) {
					response.destroy();
					return;
				}
				const next = Math.min(size, options.bytes - sent);
				sent += next;
				chunk += 1;
				state.served = sent;
				if (sent >= options.bytes) {
					state.finishedAt = Date.now();
					response.end(Buffer.alloc(next, 7));
					return;
				}
				response.write(Buffer.alloc(next, 7));
				setTimeout(tick, options.everyMs);
			};
			response.on("close", () => {
				if (state.finishedAt === null) state.closedEarly = true;
			});
			tick();
		}),
		finishedAt: null,
		closedEarly: false,
		served: 0,
	};
	await new Promise<void>((resolve) =>
		state.server.listen(0, "127.0.0.1", resolve),
	);
	context.origin = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
	origin = state;
	return state;
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
	context.objects = new Map();
	context.ledgerIds = 0;
	context.fetchedUrls = [];
	context.streamedPuts = 0;
	context.filePuts = [];
	context.filePutFails = false;
	context.extract.mockReset();
	context.extract.mockImplementation(async () => {
		const audio = Buffer.alloc(64);
		audio.writeDoubleBE(30, 0);
		return { state: "ok", audio };
	});
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 100_000,
	});
	fake().seed(developerTranscripts, {
		id: "tr-1",
		appId: "app-1",
		runId: "run-1",
		sourceUrl: SIGNED_URL,
	});
});

afterEach(async () => {
	const server = origin?.server;
	origin = null;
	if (server) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

describe("downloading a URL source from a slow server", () => {
	it.each([
		["with a Content-Length", true],
		["without a Content-Length", false],
	])(
		"completes when the server sends the file slowly %s",
		async (_label, contentLength) => {
			const server = await serve({
				bytes: 40_000,
				chunks: 5,
				everyMs: 120,
				contentLength,
			});

			const result = await run();

			expect(transcript()).toMatchObject({
				status: "complete",
				sourceBytes: 40_000,
				errorCode: null,
			});
			expect(result.success).toBe(true);
			expect(context.streamedPuts).toBe(0);
			expect(context.filePuts).toHaveLength(1);
			expect(context.filePuts[0]?.bytes).toBe(40_000);
			expect(context.filePuts[0]?.at).toBeGreaterThanOrEqual(
				server.finishedAt ?? Number.POSITIVE_INFINITY,
			);
			expect(server.served).toBe(40_000);
		},
	);

	it("fetches with the full URL, signature included", async () => {
		await serve({ bytes: 2_000, chunks: 1, everyMs: 1, contentLength: true });

		await run();

		expect(context.fetchedUrls).toEqual([SIGNED_URL]);
		expect(transcript()?.sourceUrl).toBe(SIGNED_URL);
	});

	it("says it timed out, and what the limit is, when the download runs past it", async () => {
		const server = await serve({
			bytes: 40_000,
			chunks: 40,
			everyMs: 200,
			contentLength: true,
		});
		const started = Date.now();

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_unreachable",
			errorMessage:
				"The file at the URL did not finish downloading within 2 seconds",
			reservedMicroCredits: 0,
			billedMicroCredits: 0,
		});
		expect(Date.now() - started).toBeLessThan(3_500);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(server.closedEarly).toBe(true);
		expect(server.served).toBeLessThan(40_000);
		expect(context.filePuts).toEqual([]);
		expect([...context.objects.keys()]).toEqual([]);
		expect(ledger()).toHaveLength(0);
		expect(balance()).toBe(100_000);
	});

	it("fails free when the server closes before the declared length", async () => {
		await serve({
			bytes: 40_000,
			chunks: 8,
			everyMs: 20,
			contentLength: true,
			stopAfterChunks: 3,
		});

		await run();

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "source_unreachable",
			billedMicroCredits: 0,
		});
		expect(context.filePuts).toEqual([]);
		expect(context.objects.has(SOURCE_KEY)).toBe(false);
		expect(balance()).toBe(100_000);
	});

	it("does not blame the URL when storing the downloaded file fails", async () => {
		await serve({ bytes: 4_000, chunks: 2, everyMs: 10, contentLength: true });
		context.filePutFails = true;

		await expect(run()).rejects.toThrow("storage is unavailable");

		expect(transcript()).toMatchObject({
			status: "error",
			errorCode: "transcription_failed",
			billedMicroCredits: 0,
			reservedMicroCredits: 0,
		});
		expect(balance()).toBe(100_000);
	});
});
