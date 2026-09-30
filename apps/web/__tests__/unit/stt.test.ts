import { afterEach, describe, expect, it, vi } from "vitest";
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
		).toThrow("word timestamps");
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
});
