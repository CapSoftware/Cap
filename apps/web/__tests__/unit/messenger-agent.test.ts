import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";

type LanguageModelV4GenerateResult = Awaited<
	ReturnType<MockLanguageModelV4["doGenerate"]>
>;

const getAiProviderChainMock = vi.hoisted(() => vi.fn());
const searchSupermemoryMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
}));

vi.mock("@/lib/messenger/supermemory", () => ({
	getKnowledgeTag: vi.fn(() => "knowledge"),
	searchSupermemory: searchSupermemoryMock,
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

const textResult = (text: string): LanguageModelV4GenerateResult => ({
	content: text ? [{ type: "text", text }] : [],
	finishReason: { unified: "stop", raw: undefined },
	usage: testUsage,
	warnings: [],
});

const toolCallPart = (input: Record<string, unknown>, id: string) => ({
	type: "tool-call" as const,
	toolCallId: id,
	toolName: "send_support_email",
	input: JSON.stringify(input),
});

const toolCallResult = (
	inputs: Record<string, unknown>[],
): LanguageModelV4GenerateResult => ({
	content: inputs.map((input, index) =>
		toolCallPart(input, `tool-${index + 1}`),
	),
	finishReason: { unified: "tool-calls", raw: undefined },
	usage: testUsage,
	warnings: [],
});

const makeSelection = (
	model: MockLanguageModelV4,
	overrides: Partial<AiModelSelection> = {},
): AiModelSelection => ({
	provider: "groq",
	modelId: "test-model",
	model: () => model,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 512,
	providerOptions: { groq: { parallelToolCalls: false } },
	...overrides,
});

const baseArgs = {
	userIdentity: "Test User <user@example.com>",
	identityTag: "user:user-123",
	query: "Please send this to support",
	history: [
		{
			role: "user" as const,
			content: "Uploads keep failing. Please send this to support.",
		},
	],
};

const supportEmailInput = {
	subject: "Upload issue",
	message: "The user cannot upload their recording.",
};

describe("generateMessengerAgentReply", () => {
	beforeEach(() => {
		searchSupermemoryMock.mockResolvedValue([]);
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("executes the constrained support email tool and strips spoofed fields", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallResult([{ ...supportEmailInput, email: "spoof@example.com" }]),
				textResult("Done, I sent that to the team from your account email."),
			],
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			...baseArgs,
			supportEmailTool: { execute },
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email.",
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(supportEmailInput);

		expect(model.doGenerateCalls).toHaveLength(2);
		const firstCall = model.doGenerateCalls[0];
		expect(firstCall?.maxOutputTokens).toBe(512);
		expect(firstCall?.temperature).toBe(0.65);
		expect(firstCall?.providerOptions).toEqual({
			groq: { parallelToolCalls: false },
		});

		const toolDefinition = firstCall?.tools?.[0] as
			| {
					name?: string;
					inputSchema?: { properties?: Record<string, unknown> };
			  }
			| undefined;
		expect(toolDefinition?.name).toBe("send_support_email");
		expect(toolDefinition?.inputSchema?.properties?.subject).toBeDefined();
		expect(toolDefinition?.inputSchema?.properties?.message).toBeDefined();
		expect(toolDefinition?.inputSchema?.properties?.email).toBeUndefined();

		expect(JSON.stringify(firstCall?.prompt)).toContain("Support email tool");
		expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
			"Support email sent to hello@cap.so from the user's account email. Remaining sends today: 1.",
		);
	});

	it("reports a tool error result when the support email tool fails", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallResult([supportEmailInput]),
				textResult(
					"I couldn't send that to the team right now. Please email hello@cap.so directly.",
				),
			],
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const execute = vi.fn().mockRejectedValue(new Error("provider failed"));
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			...baseArgs,
			supportEmailTool: { execute },
		});

		expect(result).toBe(
			"I couldn't send that to the team right now. Please email hello@cap.so directly.",
		);
		expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
			"Failed to send support email.",
		);
	});

	it("sends at most one support email per assistant response", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallResult([
					supportEmailInput,
					{ subject: "Second email", message: "Should be rejected." },
				]),
				textResult("Done, I sent that to the team from your account email."),
			],
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			...baseArgs,
			supportEmailTool: { execute },
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email.",
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(supportEmailInput);
		expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(
			"Only one support email can be sent per assistant response.",
		);
	});

	it("falls back to the next provider in the chain when the first fails", async () => {
		const failingModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("primary provider down");
			},
		});
		const workingModel = new MockLanguageModelV4({
			doGenerate: [textResult("Hey there!")],
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(failingModel, {
				provider: "anthropic",
				providerOptions: { anthropic: { disableParallelToolUse: true } },
			}),
			makeSelection(workingModel),
		]);

		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply(baseArgs);

		expect(result).toBe("Hey there!");
		expect(workingModel.doGenerateCalls).toHaveLength(1);
	});

	it("does not retry another provider after the support email was sent", async () => {
		let calls = 0;
		const failingAfterToolModel = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls > 1) {
					throw new Error("provider failed mid-turn");
				}
				return toolCallResult([supportEmailInput]);
			},
		});
		const secondaryModel = new MockLanguageModelV4({
			doGenerate: [textResult("Should never be used.")],
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(failingAfterToolModel),
			makeSelection(secondaryModel, { provider: "openai" }),
		]);

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			...baseArgs,
			supportEmailTool: { execute },
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email. We'll follow up with you there.",
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(secondaryModel.doGenerateCalls).toHaveLength(0);
	});

	it("uses the rate limited fallback reply when the model gives no closing text", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [toolCallResult([supportEmailInput]), textResult("")],
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const execute = vi.fn().mockResolvedValue({
			status: "rate_limited" as const,
			remainingToday: 0 as const,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			...baseArgs,
			supportEmailTool: { execute },
		});

		expect(result).toBe(
			"I couldn't send another support email from your account today. You're limited to 2 per day, but you can still email hello@cap.so directly.",
		);
	});

	it("returns the apology when every provider fails", async () => {
		const firstModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("first provider down");
			},
		});
		const secondModel = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new Error("second provider down");
			},
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(firstModel),
			makeSelection(secondModel, { provider: "openai" }),
		]);

		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply(baseArgs);

		expect(result).toBe(
			"Oh no, I'm so sorry about this! I'm having a little technical hiccup on my end. Someone from the team will jump in here shortly to help you out though!",
		);
	});

	it("uses 350 max output tokens and no tools without the support email tool", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [textResult("Happy to help!")],
		});
		getAiProviderChainMock.mockReturnValue([makeSelection(model)]);

		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply(baseArgs);

		expect(result).toBe("Happy to help!");
		const call = model.doGenerateCalls[0];
		expect(call?.maxOutputTokens).toBe(350);
		expect(call?.tools ?? []).toEqual([]);
		expect(JSON.stringify(call?.prompt)).toContain(
			"You cannot send support email",
		);
	});

	it("omits temperature for anthropic like the previous implementation", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: [textResult("Hello!")],
		});
		getAiProviderChainMock.mockReturnValue([
			makeSelection(model, {
				provider: "anthropic",
				providerOptions: { anthropic: { disableParallelToolUse: true } },
			}),
		]);

		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		await generateMessengerAgentReply(baseArgs);

		expect(model.doGenerateCalls[0]?.temperature).toBeUndefined();
	});
});
