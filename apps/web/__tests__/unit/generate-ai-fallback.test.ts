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
