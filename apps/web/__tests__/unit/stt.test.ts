import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FatalError } from "workflow";
import { whisperCppVerboseResponse } from "../fixtures/whisper-cpp-verbose-response";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

import { createEditTranscript } from "@/lib/edit-transcript";
import {
	getTranscriptionProvider,
	isTranscriptionConfigured,
	parseOpenAICompatibleTranscription,
	transcribeWithOpenAICompatible,
} from "@/lib/stt";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getTranscriptionProvider", () => {
	it("prefers STT_BASE_URL over AssemblyAI", () => {
		serverEnvMock.mockReturnValue({
			STT_BASE_URL: "http://whisper:9000/v1",
			ASSEMBLY_API_KEY: "key",
		});
		expect(getTranscriptionProvider()).toBe("openai-compatible");
	});

	it("falls back to AssemblyAI, then to nothing", () => {
		serverEnvMock.mockReturnValue({ ASSEMBLY_API_KEY: "key" });
		expect(getTranscriptionProvider()).toBe("assemblyai");

		serverEnvMock.mockReturnValue({});
		expect(getTranscriptionProvider()).toBeNull();
		expect(isTranscriptionConfigured()).toBe(false);
	});

	it("treats the empty values Docker Compose passes for unset variables as unset", () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "", ASSEMBLY_API_KEY: "" });
		expect(isTranscriptionConfigured()).toBe(false);

		serverEnvMock.mockReturnValue({
			STT_BASE_URL: "",
			ASSEMBLY_API_KEY: "key",
		});
		expect(getTranscriptionProvider()).toBe("assemblyai");
	});

	it("counts an STT endpoint alone as configured transcription", () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		expect(isTranscriptionConfigured()).toBe(true);
	});
});

describe("parseOpenAICompatibleTranscription", () => {
	it("folds whisper.cpp subword and punctuation tokens into words", () => {
		const result = parseOpenAICompatibleTranscription(
			whisperCppVerboseResponse,
			"large-v3-turbo",
		);

		expect(result.words?.map((word) => word.text)).toEqual([
			"Hello,",
			"this",
			"is",
			"a",
			"quick",
			"test",
			"of",
			"the",
			"local",
			"transcription",
			"server.",
			"Um,",
			"it",
			"should",
			"return",
			"Word",
			"timestamps.",
		]);
		expect(result.words?.at(-1)).toMatchObject({ start: 5180, end: 6300 });
		expect(result.language_code).toBe("en");
		expect(result.audio_duration).toBe(6.91);
		expect(result.speech_model_used).toBe("large-v3-turbo");
	});

	it("feeds createEditTranscript like an AssemblyAI result", () => {
		const transcript = createEditTranscript(
			parseOpenAICompatibleTranscription(whisperCppVerboseResponse, "turbo"),
			6_910,
		);

		expect(transcript.speechModelUsed).toBe("turbo");
		expect(transcript.words[0]).toMatchObject({
			text: "Hello,",
			startMs: 30,
			endMs: 490,
		});
	});

	it("keeps OpenAI top-level words as-is", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				language: "en",
				duration: 1.2,
				text: "Hi there",
				words: [
					{ word: "Hi", start: 0, end: 0.4 },
					{ word: "there", start: 0.5, end: 1.1 },
				],
			},
			"whisper-1",
		);

		expect(result.words).toEqual([
			{ text: "Hi", start: 0, end: 400, confidence: undefined },
			{ text: "there", start: 500, end: 1100, confidence: undefined },
		]);
	});

	it("folds every token of a one-word whisper.cpp segment", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: " timestamps.",
				duration: 1,
				segments: [
					{
						text: " timestamps.",
						words: [
							{ word: " timest", start: 0.1, end: 0.4 },
							{ word: "amps", start: 0.4, end: 0.7 },
							{ word: ".", start: 0.7, end: 0.8 },
						],
					},
				],
			},
			"turbo",
		);

		expect(result.words?.map((word) => word.text)).toEqual(["timestamps."]);
	});

	it("moves VAD-timeline word times onto their segment's original times", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: " Hello there. Back again.",
				duration: 400,
				segments: [
					{
						text: " Hello there.",
						start: 4.6,
						end: 5.6,
						words: [
							{ word: " Hello", start: 0.1, end: 0.5 },
							{ word: " there.", start: 0.5, end: 1.0 },
						],
					},
					{
						text: " Back again.",
						start: 300,
						end: 301.2,
						words: [
							{ word: " Back", start: 1.2, end: 1.6 },
							{ word: " again.", start: 1.6, end: 2.2 },
						],
					},
				],
			},
			"turbo",
		);

		expect(
			result.words?.map(({ text, start, end }) => ({ text, start, end })),
		).toEqual([
			{ text: "Hello", start: 4600, end: 5000 },
			{ text: "there.", start: 5000, end: 5500 },
			{ text: "Back", start: 300000, end: 300400 },
			{ text: "again.", start: 300400, end: 301000 },
		]);
	});

	it("keeps word times that already match their segment", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: " Hello there.",
				duration: 10,
				segments: [
					{
						text: " Hello there.",
						start: 4.6,
						end: 5.6,
						words: [
							{ word: " Hello", start: 4.7, end: 5.0 },
							{ word: " there.", start: 5.0, end: 5.5 },
						],
					},
				],
			},
			"turbo",
		);

		expect(result.words?.map(({ start, end }) => [start, end])).toEqual([
			[4700, 5000],
			[5000, 5500],
		]);
	});

	it("keeps segment words separate when no token marks word starts", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: "Hello world",
				segments: [
					{
						text: "Hello world",
						words: [
							{ word: "Hello", start: 0, end: 0.4 },
							{ word: "world", start: 0.5, end: 0.9 },
						],
					},
				],
			},
			"turbo",
		);

		expect(result.words?.map((word) => word.text)).toEqual(["Hello", "world"]);
	});

	it("splits words at the segment text's spaces when only some tokens mark them", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: " Hello world, again",
				segments: [
					{
						text: " Hello world, again",
						words: [
							{ word: " Hello", start: 0, end: 0.4 },
							{ word: "world", start: 0.5, end: 0.9 },
							{ word: ",", start: 0.9, end: 1 },
							{ word: "again", start: 1.1, end: 1.5 },
						],
					},
				],
			},
			"turbo",
		);

		expect(result.words?.map((word) => word.text)).toEqual([
			"Hello",
			"world,",
			"again",
		]);
	});

	it("gives zero-length fillers a span so the edit transcript keeps them", () => {
		const result = parseOpenAICompatibleTranscription(
			whisperCppVerboseResponse,
			"turbo",
		);

		expect(result.words?.find((word) => word.text === "Um,")).toMatchObject({
			start: 3720,
			end: 3750,
		});
		expect(
			createEditTranscript(result, 6_910).words.map((word) => word.text),
		).toContain("Um,");
	});

	it("spans zero-length words without overlapping a word at the same start", () => {
		const parse = (words: { word: string; start: number; end: number }[]) =>
			parseOpenAICompatibleTranscription(
				{ text: "x", words, duration: 2 },
				"whisper-1",
			).words?.map(({ text, start, end }) => ({ text, start, end }));

		expect(
			parse([
				{ word: "so", start: 0, end: 0.5 },
				{ word: "um", start: 1, end: 1 },
				{ word: "yes", start: 1, end: 1.4 },
			]),
		).toEqual([
			{ text: "so", start: 0, end: 500 },
			{ text: "um", start: 800, end: 1000 },
			{ text: "yes", start: 1000, end: 1400 },
		]);
		expect(
			parse([
				{ word: "so", start: 0, end: 1 },
				{ word: "um", start: 1, end: 1 },
				{ word: "yes", start: 1, end: 1.2 },
			]),
		).toEqual([
			{ text: "so", start: 0, end: 1000 },
			{ text: "um", start: 1000, end: 1100 },
			{ text: "yes", start: 1100, end: 1200 },
		]);
		expect(
			parse([
				{ word: "so", start: 0, end: 1 },
				{ word: "um", start: 1, end: 1 },
				{ word: "uh", start: 1, end: 1 },
				{ word: "yes", start: 1.5, end: 1.8 },
			]),
		).toEqual([
			{ text: "so", start: 0, end: 1000 },
			{ text: "um", start: 1000, end: 1100 },
			{ text: "uh", start: 1100, end: 1200 },
			{ text: "yes", start: 1500, end: 1800 },
		]);
	});

	it("falls back to the last word end when duration is missing", () => {
		const { duration: _duration, ...withoutDuration } =
			whisperCppVerboseResponse;

		expect(
			parseOpenAICompatibleTranscription(withoutDuration, "turbo")
				.audio_duration,
		).toBe(6.3);
	});

	it("treats a zero duration as missing", () => {
		expect(
			parseOpenAICompatibleTranscription(
				{ ...whisperCppVerboseResponse, duration: 0 },
				"turbo",
			).audio_duration,
		).toBe(6.3);
	});

	it("maps full language names to codes", () => {
		expect(
			parseOpenAICompatibleTranscription(
				{ language: "Portuguese", text: "", segments: [] },
				"whisper-1",
			).language_code,
		).toBe("pt");
	});

	it("only folds punctuation in scripts without spaces", () => {
		const result = parseOpenAICompatibleTranscription(
			{
				text: "你好世界。",
				segments: [
					{
						text: "你好世界。",
						words: [
							{ word: "你好", start: 0, end: 0.5 },
							{ word: "世界", start: 0.5, end: 1 },
							{ word: "。", start: 1, end: 1.1 },
						],
					},
				],
			},
			"turbo",
		);

		expect(result.words?.map((word) => word.text)).toEqual(["你好", "世界。"]);
	});

	it("rejects endpoints that return text without word timestamps", () => {
		expect(() =>
			parseOpenAICompatibleTranscription({ text: "hello" }, "turbo"),
		).toThrow(FatalError);
	});

	it("rejects a JSON object that isn't a transcription", () => {
		expect(() =>
			parseOpenAICompatibleTranscription({ status: "ok" }, "turbo"),
		).toThrow(FatalError);
	});

	it("returns no words for silent audio", () => {
		expect(
			parseOpenAICompatibleTranscription({ text: "", segments: [] }, "turbo")
				.words,
		).toEqual([]);
	});
});

describe("transcribeWithOpenAICompatible", () => {
	it("requests verbose_json with word timestamps and the pinned language", async () => {
		serverEnvMock.mockReturnValue({
			STT_BASE_URL: "http://whisper:9000/v1/",
			STT_MODEL: "large-v3-turbo",
			STT_API_KEY: "secret",
		});
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify(whisperCppVerboseResponse)),
		);
		vi.stubGlobal("fetch", fetchMock);

		await transcribeWithOpenAICompatible(
			Buffer.from("mp3"),
			"audio/mpeg",
			"pt",
		);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("http://whisper:9000/v1/audio/transcriptions");
		expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
		expect(init?.redirect).toBe("error");
		const form = init?.body as FormData;
		expect(form.get("model")).toBe("large-v3-turbo");
		expect(form.get("response_format")).toBe("verbose_json");
		expect(form.getAll("timestamp_granularities[]")).toEqual(["word"]);
		expect(form.get("language")).toBe("pt");
		expect((form.get("file") as File).name).toBe("audio.mp3");
	});

	it("omits language for auto-detect and names fMP4 audio as m4a", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify(whisperCppVerboseResponse)),
		);
		vi.stubGlobal("fetch", fetchMock);

		await transcribeWithOpenAICompatible(
			Buffer.from("m4a"),
			"audio/mp4",
			"auto",
		);

		const init = fetchMock.mock.calls[0]?.[1];
		const form = init?.body as FormData;
		expect(form.has("language")).toBe(false);
		expect(init?.headers).toBeUndefined();
		expect((form.get("file") as File).name).toBe("audio.m4a");
	});

	it("uses the default model when STT_MODEL is empty", async () => {
		serverEnvMock.mockReturnValue({
			STT_BASE_URL: "http://whisper:9000/v1",
			STT_MODEL: "",
			STT_API_KEY: "",
		});
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify(whisperCppVerboseResponse)),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await transcribeWithOpenAICompatible(
			Buffer.from("mp3"),
			"audio/mpeg",
			"auto",
		);

		const init = fetchMock.mock.calls[0]?.[1];
		expect((init?.body as FormData).get("model")).toBe("whisper-1");
		expect(init?.headers).toBeUndefined();
		expect(result.speech_model_used).toBe("whisper-1");
	});

	it("surfaces the provider's error body", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("model not loaded", {
						status: 503,
						statusText: "Service Unavailable",
					}),
			),
		);

		await expect(
			transcribeWithOpenAICompatible(Buffer.from("mp3"), "audio/mpeg", "auto"),
		).rejects.toThrow(
			"STT request failed: 503 Service Unavailable model not loaded",
		);
	});

	it("does not retry client errors", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("unknown model", {
						status: 404,
						statusText: "Not Found",
					}),
			),
		);

		await expect(
			transcribeWithOpenAICompatible(Buffer.from("mp3"), "audio/mpeg", "auto"),
		).rejects.toBeInstanceOf(FatalError);
	});

	it("rejects non-JSON responses as a configuration error", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://cap:3000" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html></html>")),
		);

		const error = await transcribeWithOpenAICompatible(
			Buffer.from("mp3"),
			"audio/mpeg",
			"auto",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(FatalError);
		expect((error as Error).message).toContain("did not return JSON");
	});

	it("retries when the response body cannot be read", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"text":'));
				controller.error(new Error("socket hang up"));
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body)),
		);

		const error = await transcribeWithOpenAICompatible(
			Buffer.from("mp3"),
			"audio/mpeg",
			"auto",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(FatalError);
		expect((error as Error).message).toBe(
			"STT endpoint http://whisper:9000/v1/audio/transcriptions response interrupted: socket hang up",
		);
	});

	describe("over a real connection", () => {
		let server: Server | undefined;

		afterEach(async () => {
			const running = server;
			server = undefined;
			if (!running) return;
			running.closeAllConnections();
			await new Promise<void>((resolve) => running.close(() => resolve()));
		});

		async function listen(handler: RequestListener) {
			const running = createServer(handler);
			server = running;
			await new Promise<void>((resolve) =>
				running.listen(0, "127.0.0.1", resolve),
			);
			const { port } = running.address() as AddressInfo;
			serverEnvMock.mockReturnValue({
				STT_BASE_URL: `http://127.0.0.1:${port}/v1`,
			});
		}

		it("retries when the connection resets after the headers", async () => {
			await listen((request, response) => {
				request.resume();
				response.writeHead(200, {
					"Content-Type": "application/json",
					"Content-Length": "10000",
				});
				response.write('{"text":');
				setTimeout(() => response.destroy(), 30);
			});

			const error = await transcribeWithOpenAICompatible(
				Buffer.from("mp3"),
				"audio/mpeg",
				"auto",
			).catch((caught: unknown) => caught);
			expect(error).not.toBeInstanceOf(FatalError);
			expect((error as Error).message).toContain("response interrupted");
		});

		it("retries when the request times out while the body is read", async () => {
			const timeout = AbortSignal.timeout.bind(AbortSignal);
			const timeoutSpy = vi
				.spyOn(AbortSignal, "timeout")
				.mockImplementation(() => timeout(100));
			await listen((request, response) => {
				request.resume();
				response.writeHead(200, { "Content-Type": "application/json" });
				response.write('{"text":');
			});

			const error = await transcribeWithOpenAICompatible(
				Buffer.from("mp3"),
				"audio/mpeg",
				"auto",
			).catch((caught: unknown) => caught);
			timeoutSpy.mockRestore();
			expect(error).not.toBeInstanceOf(FatalError);
			expect((error as Error).message).toContain("response interrupted");
		});
	});

	it("names the endpoint when it is unreachable", async () => {
		serverEnvMock.mockReturnValue({ STT_BASE_URL: "http://whisper:9000/v1" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		const error = await transcribeWithOpenAICompatible(
			Buffer.from("mp3"),
			"audio/mpeg",
			"auto",
		).catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(FatalError);
		expect((error as Error).message).toBe(
			"STT endpoint http://whisper:9000/v1/audio/transcriptions unreachable: fetch failed",
		);
	});
});
