import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ServerEnvMockValue = {
	ANTHROPIC_API_KEY: string | undefined;
	OPENAI_API_KEY: string | undefined;
	GROQ_API_KEY: string | undefined;
	SUPERMEMORY_API_KEY: string | undefined;
	SUPERMEMORY_KNOWLEDGE_TAG: string | undefined;
};

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => ServerEnvMockValue>(() => ({
		ANTHROPIC_API_KEY: "anthropic-key",
		OPENAI_API_KEY: undefined,
		GROQ_API_KEY: undefined,
		SUPERMEMORY_API_KEY: undefined,
		SUPERMEMORY_KNOWLEDGE_TAG: undefined,
	})),
);
const searchSupermemoryMock = vi.hoisted(() => vi.fn());
const getGroqClientMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

vi.mock("@/lib/groq-client", () => ({
	GROQ_MODEL: "groq-model",
	getGroqClient: getGroqClientMock,
}));

vi.mock("@/lib/messenger/supermemory", () => ({
	getKnowledgeTag: vi.fn(() => "knowledge"),
	searchSupermemory: searchSupermemoryMock,
}));

const readFetchBody = (call: unknown[]) => {
	const init = call[1] as { body?: unknown };
	if (typeof init.body !== "string") {
		throw new Error("Expected fetch body");
	}
	return JSON.parse(init.body) as {
		model?: string;
		max_tokens?: number;
		tool_choice?: string;
		parallel_tool_calls?: boolean;
		tools?: Array<{
			name?: string;
			input_schema?: {
				properties?: Record<string, unknown>;
			};
			function?: {
				name?: string;
				parameters?: {
					properties?: Record<string, unknown>;
				};
			};
		}>;
		messages?: Array<{
			role?: string;
			content?: unknown;
			tool_calls?: unknown;
			tool_call_id?: string;
		}>;
	};
};

describe("generateMessengerAgentReply", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serverEnvMock.mockReturnValue({
			ANTHROPIC_API_KEY: "anthropic-key",
			OPENAI_API_KEY: undefined,
			GROQ_API_KEY: undefined,
			SUPERMEMORY_API_KEY: undefined,
			SUPERMEMORY_KNOWLEDGE_TAG: undefined,
		});
		searchSupermemoryMock.mockResolvedValue([]);
		getGroqClientMock.mockReturnValue(null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses Sonnet 5 and executes the constrained support email tool", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "send_support_email",
								input: {
									subject: "Upload issue",
									message: "The user cannot upload their recording.",
									email: "spoof@example.com",
								},
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: [
							{
								type: "text",
								text: "Done, I sent that to the team from your account email.",
							},
						],
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			userIdentity: "Test User <user@example.com>",
			identityTag: "user:user-123",
			query: "Please send this to support",
			history: [
				{
					role: "user",
					content: "Uploads keep failing. Please send this to support.",
				},
			],
			supportEmailTool: {
				execute,
			},
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email.",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstBody = readFetchBody(fetchMock.mock.calls[0] ?? []);
		expect(firstBody.model).toBe("claude-sonnet-5");
		expect(firstBody.max_tokens).toBe(512);
		expect(firstBody.tools?.[0]?.name).toBe("send_support_email");
		expect(firstBody.tools?.[0]?.input_schema?.properties?.email).toBe(
			undefined,
		);
		expect(execute).toHaveBeenCalledWith({
			subject: "Upload issue",
			message: "The user cannot upload their recording.",
		});

		const secondBody = readFetchBody(fetchMock.mock.calls[1] ?? []);
		expect(secondBody.max_tokens).toBe(350);
		const toolResultMessage = secondBody.messages?.at(-1);
		expect(toolResultMessage?.role).toBe("user");
		expect(toolResultMessage?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content:
					"Support email sent to hello@cap.so from the user's account email. Remaining sends today: 1.",
			},
		]);
	});

	it("returns a tool error result when the support email tool fails", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "send_support_email",
								input: {
									subject: "Upload issue",
									message: "The user cannot upload their recording.",
								},
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						content: [
							{
								type: "text",
								text: "I couldn't send that to the team right now. Please email hello@cap.so directly.",
							},
						],
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const execute = vi.fn().mockRejectedValue(new Error("provider failed"));
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			userIdentity: "Test User <user@example.com>",
			identityTag: "user:user-123",
			query: "Please send this to support",
			history: [
				{
					role: "user",
					content: "Uploads keep failing. Please send this to support.",
				},
			],
			supportEmailTool: {
				execute,
			},
		});

		expect(result).toBe(
			"I couldn't send that to the team right now. Please email hello@cap.so directly.",
		);

		const secondBody = readFetchBody(fetchMock.mock.calls[1] ?? []);
		const toolResultMessage = secondBody.messages?.at(-1);
		expect(toolResultMessage?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: "Failed to send support email.",
				is_error: true,
			},
		]);
	});

	it("executes the support email tool through OpenAI fallback", async () => {
		serverEnvMock.mockReturnValue({
			ANTHROPIC_API_KEY: undefined,
			OPENAI_API_KEY: "openai-key",
			GROQ_API_KEY: undefined,
			SUPERMEMORY_API_KEY: undefined,
			SUPERMEMORY_KNOWLEDGE_TAG: undefined,
		});
		const toolCalls = [
			{
				id: "call-1",
				type: "function",
				function: {
					name: "send_support_email",
					arguments: JSON.stringify({
						subject: "Upload issue",
						message: "The user cannot upload their recording.",
						email: "spoof@example.com",
					}),
				},
			},
		];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: null,
									tool_calls: toolCalls,
								},
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content:
										"Done, I sent that to the team from your account email.",
								},
							},
						],
					}),
					{ status: 200 },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			userIdentity: "Test User <user@example.com>",
			identityTag: "user:user-123",
			query: "Please send this to support",
			history: [
				{
					role: "user",
					content: "Uploads keep failing. Please send this to support.",
				},
			],
			supportEmailTool: {
				execute,
			},
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email.",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstBody = readFetchBody(fetchMock.mock.calls[0] ?? []);
		expect(firstBody.model).toBe("gpt-4o-mini");
		expect(firstBody.max_tokens).toBe(512);
		expect(firstBody.tool_choice).toBe("auto");
		expect(firstBody.parallel_tool_calls).toBe(false);
		expect(firstBody.tools?.[0]?.function?.name).toBe("send_support_email");
		expect(firstBody.tools?.[0]?.function?.parameters?.properties?.email).toBe(
			undefined,
		);
		expect(firstBody.messages?.[0]?.content).toContain("Support email tool");
		expect(firstBody.messages?.[0]?.content).not.toContain(
			"You cannot send support email",
		);
		expect(execute).toHaveBeenCalledWith({
			subject: "Upload issue",
			message: "The user cannot upload their recording.",
		});

		const secondBody = readFetchBody(fetchMock.mock.calls[1] ?? []);
		expect(secondBody.max_tokens).toBe(350);
		expect(secondBody.tools).toBeUndefined();
		expect(secondBody.messages?.at(-2)?.role).toBe("assistant");
		expect(secondBody.messages?.at(-2)?.tool_calls).toEqual(toolCalls);
		expect(secondBody.messages?.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "call-1",
			content:
				"Support email sent to hello@cap.so from the user's account email. Remaining sends today: 1.",
		});
	});

	it("executes the support email tool through Groq fallback", async () => {
		serverEnvMock.mockReturnValue({
			ANTHROPIC_API_KEY: undefined,
			OPENAI_API_KEY: undefined,
			GROQ_API_KEY: "groq-key",
			SUPERMEMORY_API_KEY: undefined,
			SUPERMEMORY_KNOWLEDGE_TAG: undefined,
		});
		const create = vi
			.fn()
			.mockResolvedValueOnce({
				choices: [
					{
						message: {
							content: null,
							tool_calls: [
								{
									id: "call-1",
									type: "function",
									function: {
										name: "send_support_email",
										arguments: JSON.stringify({
											subject: "Upload issue",
											message: "The user cannot upload their recording.",
										}),
									},
								},
							],
						},
					},
				],
			})
			.mockResolvedValueOnce({
				choices: [
					{
						message: {
							content: "Done, I sent that to the team from your account email.",
						},
					},
				],
			});
		getGroqClientMock.mockReturnValue({
			chat: {
				completions: {
					create,
				},
			},
		});

		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			userIdentity: "Test User <user@example.com>",
			identityTag: "user:user-123",
			query: "Please send this to support",
			history: [
				{
					role: "user",
					content: "Uploads keep failing. Please send this to support.",
				},
			],
			supportEmailTool: {
				execute,
			},
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email.",
		);
		expect(create).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			model: "groq-model",
			max_tokens: 512,
			tool_choice: "auto",
			parallel_tool_calls: false,
			tools: [
				{
					type: "function",
					function: {
						name: "send_support_email",
					},
				},
			],
		});
		expect(create.mock.calls[1]?.[0]).toMatchObject({
			max_tokens: 350,
			messages: expect.arrayContaining([
				{
					role: "tool",
					tool_call_id: "call-1",
					content:
						"Support email sent to hello@cap.so from the user's account email. Remaining sends today: 1.",
				},
			]),
		});
		expect(execute).toHaveBeenCalledWith({
			subject: "Upload issue",
			message: "The user cannot upload their recording.",
		});
	});

	it("does not retry another provider after a fallback provider sends support email", async () => {
		serverEnvMock.mockReturnValue({
			ANTHROPIC_API_KEY: undefined,
			OPENAI_API_KEY: "openai-key",
			GROQ_API_KEY: "groq-key",
			SUPERMEMORY_API_KEY: undefined,
			SUPERMEMORY_KNOWLEDGE_TAG: undefined,
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: null,
									tool_calls: [
										{
											id: "call-1",
											type: "function",
											function: {
												name: "send_support_email",
												arguments: JSON.stringify({
													subject: "Upload issue",
													message: "The user cannot upload their recording.",
												}),
											},
										},
									],
								},
							},
						],
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(new Response("provider failed", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const create = vi.fn();
		getGroqClientMock.mockReturnValue({
			chat: {
				completions: {
					create,
				},
			},
		});
		const execute = vi.fn().mockResolvedValue({
			status: "sent" as const,
			remainingToday: 1,
		});
		const { generateMessengerAgentReply } = await import(
			"@/lib/messenger/agent"
		);

		const result = await generateMessengerAgentReply({
			userIdentity: "Test User <user@example.com>",
			identityTag: "user:user-123",
			query: "Please send this to support",
			history: [
				{
					role: "user",
					content: "Uploads keep failing. Please send this to support.",
				},
			],
			supportEmailTool: {
				execute,
			},
		});

		expect(result).toBe(
			"Done, I sent that to the team from your account email. We'll follow up with you there.",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(create).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
