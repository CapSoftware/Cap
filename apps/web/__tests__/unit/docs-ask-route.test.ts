import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";

const getAiProviderChainMock = vi.hoisted(() => vi.fn());
const isAiConfiguredMock = vi.hoisted(() => vi.fn());
const isRateLimitedMock = vi.hoisted(() => vi.fn());
const getAllDocsMock = vi.hoisted(() => vi.fn());
const buildDocsAskContextMock = vi.hoisted(() => vi.fn());
const buildDocsAskSystemPromptMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
	isAiConfigured: isAiConfiguredMock,
}));

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: isRateLimitedMock,
	RATE_LIMIT_IDS: { DOCS_ASK: "docs-ask" },
}));

vi.mock("@/utils/docs", () => ({
	getAllDocs: getAllDocsMock,
}));

vi.mock("@/lib/docs-ask", () => ({
	buildDocsAskContext: buildDocsAskContextMock,
	buildDocsAskSystemPrompt: buildDocsAskSystemPromptMock,
}));

const testUsage = {
	inputTokens: {
		total: 1,
		noCache: 1,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: {
		total: 1,
		text: 1,
		reasoning: undefined,
	},
};

const streamFromDeltas = (deltas: string[]) =>
	convertArrayToReadableStream([
		{ type: "stream-start" as const, warnings: [] },
		{ type: "text-start" as const, id: "1" },
		...deltas.map((delta) => ({
			type: "text-delta" as const,
			id: "1",
			delta,
		})),
		{ type: "text-end" as const, id: "1" },
		{
			type: "finish" as const,
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: testUsage,
		},
	]);

const makeSelection = (
	model: MockLanguageModelV4,
	overrides: Partial<AiModelSelection> = {},
): AiModelSelection => ({
	provider: "groq",
	modelId: "test-model",
	model: () => model,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 2000,
	...overrides,
});

const makeRequest = (body: unknown) =>
	new Request("http://localhost/api/docs/ask", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as NextRequest;

describe("docs ask route", () => {
	beforeEach(() => {
		isAiConfiguredMock.mockReturnValue(true);
		isRateLimitedMock.mockResolvedValue(false);
		getAllDocsMock.mockReturnValue([]);
		buildDocsAskContextMock.mockReturnValue({ context: "" });
		buildDocsAskSystemPromptMock.mockReturnValue("system prompt");
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("streams the model output as plain text", async () => {
		const model = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Hello ", "world!"]) },
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.text()).resolves.toBe("Hello world!");
	});

	it("falls through to the next provider when streaming setup fails", async () => {
		const failingModel = new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("primary provider down");
			},
		});
		const workingModel = new MockLanguageModelV4({
			doStream: { stream: streamFromDeltas(["Hello ", "world!"]) },
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(failingModel),
			makeSelection(workingModel, { provider: "openai" }),
		]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("Hello world!");
	});

	it("returns 503 when no AI provider is configured", async () => {
		isAiConfiguredMock.mockReturnValue(false);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "Ask AI is not available right now. Try searching instead.",
		});
		// The gate must ask about the streaming role — a generation-only
		// configuration must not let requests through to an empty chain.
		expect(isAiConfiguredMock).toHaveBeenCalledWith("chat-streaming");
	});

	it("returns 502 when every provider fails", async () => {
		const failingModel = new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("provider down");
			},
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(failingModel)]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(
			makeRequest({ question: "How do I record my screen?" }),
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({
			error: "Ask AI is having trouble right now. Try again shortly.",
		});
	});

	it("rejects questions that are too short", async () => {
		getAiProviderChainMock.mockReturnValue([]);

		const { POST } = await import("@/app/api/docs/ask/route");
		const response = await POST(makeRequest({ question: "hi" }));

		expect(response.status).toBe(400);
	});
});
