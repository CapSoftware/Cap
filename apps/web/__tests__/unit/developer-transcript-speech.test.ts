import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
	isCap: "true" as string | undefined,
	transcribe: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
}));

vi.mock("@/lib/assemblyai", () => ({
	createAssemblyAIClient: () => ({
		transcripts: { transcribe: mocks.transcribe },
	}),
	getAssemblyAITranscriptionOptions: (language: string) => ({ language }),
}));

import {
	isSpeechConfigured,
	parseTranscriptLanguage,
	transcribeSpeech,
} from "@/lib/developer-transcript-speech";

describe("isSpeechConfigured", () => {
	beforeEach(() => {
		mocks.env = {};
		mocks.isCap = "true";
	});

	it("is off without a key", () => {
		mocks.env = { ASSEMBLY_BASE_URL: "https://speech.internal.example" };
		expect(isSpeechConfigured()).toBe(false);
	});

	it("needs Cap's own speech endpoint on the hosted product", () => {
		mocks.env = { ASSEMBLY_API_KEY: "key" };
		expect(isSpeechConfigured()).toBe(false);
		mocks.env = {
			ASSEMBLY_API_KEY: "key",
			ASSEMBLY_BASE_URL: "https://speech.internal.example",
		};
		expect(isSpeechConfigured()).toBe(true);
	});

	it("runs with only a key on self-hosted installs", () => {
		mocks.isCap = undefined;
		mocks.env = { ASSEMBLY_API_KEY: "key" };
		expect(isSpeechConfigured()).toBe(true);
	});
});

describe("parseTranscriptLanguage", () => {
	it("defaults to auto", () => {
		expect(parseTranscriptLanguage(undefined)).toBe("auto");
		expect(parseTranscriptLanguage(null)).toBe("auto");
		expect(parseTranscriptLanguage("")).toBe("auto");
		expect(parseTranscriptLanguage(" AUTO ")).toBe("auto");
	});

	it("accepts supported codes in any case", () => {
		expect(parseTranscriptLanguage("en")).toBe("en");
		expect(parseTranscriptLanguage(" DE ")).toBe("de");
		expect(parseTranscriptLanguage("he")).toBe("he");
	});

	it("rejects anything else", () => {
		expect(parseTranscriptLanguage("xx")).toBeNull();
		expect(parseTranscriptLanguage("english")).toBeNull();
		expect(parseTranscriptLanguage("en-US")).toBeNull();
	});
});

describe("transcribeSpeech", () => {
	beforeEach(() => mocks.transcribe.mockReset());

	it("returns the text, words, language and measured length", async () => {
		mocks.transcribe.mockResolvedValue({
			status: "completed",
			text: "hello world",
			words: [
				{ text: "hello", start: 0, end: 400, confidence: 0.9, speaker: null },
				{ text: "world", start: 450, end: 900, confidence: 0.8, speaker: null },
			],
			language_code: "en",
			audio_duration: 1.2,
		});
		const audio = Buffer.from("audio");
		expect(await transcribeSpeech(audio, "auto")).toEqual({
			state: "ok",
			text: "hello world",
			words: [
				{ text: "hello", start: 0, end: 400, confidence: 0.9 },
				{ text: "world", start: 450, end: 900, confidence: 0.8 },
			],
			language: "en",
			durationSeconds: 1.2,
		});
		expect(mocks.transcribe).toHaveBeenCalledWith({ audio, language: "auto" });
	});

	it("reports silence as no speech", async () => {
		mocks.transcribe.mockResolvedValue({
			status: "error",
			error: "Transcript text is empty: no spoken audio detected",
		});
		expect(await transcribeSpeech(Buffer.from("a"), "en")).toEqual({
			state: "no_speech",
		});
	});

	it("throws on any other failure so the job retries", async () => {
		mocks.transcribe.mockResolvedValue({
			status: "error",
			error: "overloaded",
		});
		await expect(transcribeSpeech(Buffer.from("a"), "en")).rejects.toThrow(
			"overloaded",
		);
	});

	it("tolerates a response without words or a length", async () => {
		mocks.transcribe.mockResolvedValue({ status: "completed", text: null });
		expect(await transcribeSpeech(Buffer.from("a"), "en")).toEqual({
			state: "ok",
			text: null,
			words: [],
			language: null,
			durationSeconds: null,
		});
	});
});
