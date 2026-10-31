import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";

const generateTextMock = vi.hoisted(() => vi.fn());
const getAiProviderChainMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
	generateText: generateTextMock,
	APICallError: { isInstance: () => false },
}));

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
	isAiConfigured: vi.fn(() => true),
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {},
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("server-only", () => ({}));

import { AiUnavailableError } from "@/lib/ai/run";
import {
	callAiApi,
	chunkTranscriptForProviderChain,
	estimateTokens,
	parseAiResponse,
	parseChunkAnalysis,
	parseFinalSummary,
} from "@/workflows/generate-ai";

const makeSelection = (provider: string): AiModelSelection => ({
	provider: provider as AiModelSelection["provider"],
	modelId: `${provider}-model`,
	model: () => ({}) as ReturnType<AiModelSelection["model"]>,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 8000,
});

const VALID_JSON =
	'{"title":"Workflow review","summary":"I explain the workflow.","chapters":[]}';

describe("callAiApi provider fallback on invalid output", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
	});

	it("falls through to the next provider when a fulfilled response is malformed", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: "I could not produce JSON" })
			.mockResolvedValueOnce({ text: VALID_JSON });

		await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
			title: "Workflow review",
			summary: "I explain the workflow.",
			chapters: [],
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	});

	it("falls through to the next provider when a fulfilled response is empty or truncated", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: "" })
			.mockResolvedValueOnce({ text: '{"title":"Cut off","summary":"' })
			.mockResolvedValueOnce({ text: VALID_JSON });
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
			makeSelection("anthropic"),
		]);

		await expect(callAiApi("prompt", parseAiResponse)).resolves.toMatchObject({
			title: "Workflow review",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(3);
	});

	it("marks the terminal failure as invalid output when every provider returns unusable text", async () => {
		generateTextMock.mockResolvedValue({ text: "still not JSON" });

		const error = await callAiApi("prompt", parseAiResponse).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(AiUnavailableError);
		expect((error.cause as Error).name).toBe("InvalidAiOutputError");
	});

	it("falls through when valid JSON is missing required fields", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: '{"chapters":[]}' })
			.mockResolvedValueOnce({
				text: '{"title":"Workflow review","summary":"I explain the workflow."}',
			});

		await expect(callAiApi("prompt", parseFinalSummary)).resolves.toEqual({
			title: "Workflow review",
			summary: "I explain the workflow.",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	});

	it("keeps request-level chain failures distinguishable from invalid output", async () => {
		const outage = new Error("connect ECONNREFUSED");
		generateTextMock
			.mockResolvedValueOnce({ text: "not JSON" })
			.mockRejectedValueOnce(outage);

		const error = await callAiApi("prompt", parseAiResponse).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(AiUnavailableError);
		expect(error.cause).toBe(outage);
	});
});

describe("map-reduce output parsers", () => {
	it("parseChunkAnalysis rejects missing or empty section summaries", () => {
		expect(() => parseChunkAnalysis("{}")).toThrow();
		expect(() =>
			parseChunkAnalysis('{"summary":"  ","keyPoints":[],"chapters":[]}'),
		).toThrow();
	});

	it("parseChunkAnalysis defaults optional arrays", () => {
		expect(parseChunkAnalysis('{"summary":"Covers the retry queue."}')).toEqual(
			{
				summary: "Covers the retry queue.",
				keyPoints: [],
				chapters: [],
			},
		);
	});

	it("parseChunkAnalysis sanitizes malformed array fields", () => {
		expect(
			parseChunkAnalysis(
				'{"summary":"Covers the retry queue.","keyPoints":"one point","chapters":{"title":"Intro"}}',
			),
		).toEqual({
			summary: "Covers the retry queue.",
			keyPoints: [],
			chapters: [],
		});

		expect(
			parseChunkAnalysis(
				'{"summary":"Covers the retry queue.","keyPoints":["kept",42,null],"chapters":[{"title":"Intro","start":0},{"title":"","start":5},{"title":"No start"},{"start":9},null,"Outro"]}',
			),
		).toEqual({
			summary: "Covers the retry queue.",
			keyPoints: ["kept"],
			chapters: [{ title: "Intro", start: 0 }],
		});
	});

	it("parseFinalSummary rejects missing or empty required fields", () => {
		expect(() => parseFinalSummary('{"title":"Only a title"}')).toThrow();
		expect(() => parseFinalSummary('{"summary":"Only a summary"}')).toThrow();
		expect(() => parseFinalSummary('{"title":"","summary":""}')).toThrow();
	});
});

describe("transcript chunk budget", () => {
	// A typical eight-word, 40-character VTT cue.
	const CUE = "Then we checked the numbers for the week";
	const cues = (count: number, text = CUE) =>
		Array.from({ length: count }, (_, i) => ({ start: i * 3, text }));

	describe("hosted chains keep the 24,000-character chunks", () => {
		beforeEach(() => {
			getAiProviderChainMock.mockReturnValue([
				makeSelection("groq"),
				makeSelection("openai"),
			]);
		});

		it("fits 585 cues in one chunk and splits at 586", () => {
			expect(chunkTranscriptForProviderChain(cues(585))).toHaveLength(1);

			const chunks = chunkTranscriptForProviderChain(cues(586));

			expect(chunks.map((chunk) => chunk.text.length)).toEqual([23984, 40]);
			expect(chunks.map((chunk) => [chunk.startTime, chunk.endTime])).toEqual([
				[0, 1752],
				[1755, 1755],
			]);
		});

		it("allows exactly 24,000 joined characters and splits at 24,001", () => {
			const withLastCue = (length: number) =>
				chunkTranscriptForProviderChain([
					...cues(585),
					{ start: 1755, text: "x".repeat(length) },
				]).map((chunk) => chunk.text.length);

			expect(withLastCue(15)).toEqual([24000]);
			expect(withLastCue(16)).toEqual([23984, 16]);
		});

		it("keeps an oversized first segment whole", () => {
			const chunks = chunkTranscriptForProviderChain([
				{ start: 0, text: "a".repeat(30000) },
				{ start: 5, text: "b".repeat(10) },
			]);

			expect(chunks.map((chunk) => chunk.text.length)).toEqual([30000, 10]);
		});

		it("counts non-ASCII text by string length, not estimated tokens", () => {
			const japanese = chunkTranscriptForProviderChain(
				cues(1600, "会議の要約です会議の要約です"),
			);
			// Each emoji is two UTF-16 units.
			const emoji = chunkTranscriptForProviderChain([
				{ start: 0, text: "😀".repeat(6001) },
				{ start: 5, text: "b".repeat(11999) },
			]);

			expect(japanese.map((chunk) => chunk.text.length)).toEqual([23999]);
			expect(emoji.map((chunk) => chunk.text.length)).toEqual([12002, 11999]);
		});
	});

	it("uses the token budget when openai-compatible is only a fallback", () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai-compatible"),
		]);

		expect(chunkTranscriptForProviderChain(cues(585))).toHaveLength(6);
	});

	it("estimates one token per non-ASCII character", () => {
		expect(estimateTokens("abcdefgh")).toBe(2);
		expect(estimateTokens("会議の要約")).toBe(5);
	});

	it("splits a transcript so no chunk exceeds the token budget", () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("openai-compatible"),
		]);
		const text = "We reviewed the search console numbers for the client today.";
		const segments = Array.from({ length: 300 }, (_, i) => ({
			start: i * 4,
			text,
		}));

		const chunks = chunkTranscriptForProviderChain(segments);

		expect(getAiProviderChainMock).toHaveBeenLastCalledWith("generation");
		// 15 tokens of text plus 6 for the timestamp: 85 segments fit in 1,800.
		expect(
			chunks.map((chunk) => (chunk.text.length + 1) / (text.length + 1)),
		).toEqual([85, 85, 85, 45]);
		expect(chunks[0]?.startTime).toBe(0);
		expect(chunks[chunks.length - 1]?.endTime).toBe(299 * 4);
	});
});
