import "server-only";

import type { MessengerMessageRole } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
} from "groq-sdk/resources/chat";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { CAP_REFERENCE_GUIDE, MESSENGER_AGENT_PROMPT } from "./constants";
import { getKnowledgeTag, searchSupermemory } from "./supermemory";

type ConversationMessage = {
	role: MessengerMessageRole;
	content: string;
};

type SupportEmailToolInput = {
	subject: string;
	message: string;
};

type SupportEmailToolResult =
	| {
			status: "sent";
			remainingToday: number;
	  }
	| {
			status: "rate_limited";
			remainingToday: 0;
	  };

type SupportEmailTool = {
	execute: (input: SupportEmailToolInput) => Promise<SupportEmailToolResult>;
};

type AnthropicTextBlock = {
	type: "text";
	text: string;
};

type AnthropicToolUseBlock = {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
};

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock;

type AnthropicToolResultBlock = {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
};

type SupportEmailExecutionResult = {
	content: string;
	isError?: boolean;
};

const MESSENGER_ANTHROPIC_MODEL = "claude-sonnet-5";
const MESSENGER_MAX_TOKENS = 350;
const MESSENGER_TOOL_DISPATCH_MAX_TOKENS = 512;

const normalizeContext = (sections: string[]) =>
	sections
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.slice(0, 6)
		.join("\n\n")
		.slice(0, 7000);

const supportEmailToolDefinition = {
	name: "send_support_email",
	description:
		"Send a concise support email to the Cap team after the signed-in user explicitly asks or agrees. The server controls the recipient, sender, reply-to address, account email, conversation id, and rate limit.",
	input_schema: {
		type: "object",
		properties: {
			subject: {
				type: "string",
				description: "A concise support email subject.",
			},
			message: {
				type: "string",
				description:
					"A concise support email body summarizing the user's issue and relevant context from the chat.",
			},
		},
		required: ["subject", "message"],
		additionalProperties: false,
	},
} as const;

const openAiCompatibleSupportEmailToolDefinition = {
	type: "function",
	function: {
		name: supportEmailToolDefinition.name,
		description: supportEmailToolDefinition.description,
		parameters: supportEmailToolDefinition.input_schema,
	},
} satisfies ChatCompletionTool;

const buildSystemPrompt = ({
	userIdentity,
	context,
	supportEmailAvailable,
}: {
	userIdentity: string;
	context: string;
	supportEmailAvailable: boolean;
}) =>
	[
		MESSENGER_AGENT_PROMPT,
		`You are chatting with a Cap user in a live support chat. This is a real conversation, not a ticket. Write like you're messaging a colleague, not composing a formal email.

Critical rules:
- You ARE a Cap employee. Cap is YOUR company. ALWAYS use "we", "our", "us" when talking about Cap, its features, plans, and decisions. Never refer to Cap in the third person like an outsider. For example say "we built this to be lightweight" not "Cap is lightweight", say "our Pro plan includes..." not "Cap Pro includes...", say "we support Mac and Windows" not "Cap works on Mac and Windows". You're on the team, talk like it.
- NEVER use em dashes (the long dash character). Use commas, periods, or just start a new sentence instead.
- NEVER use markdown formatting (no **bold**, no *italics*, no headers, no code blocks unless sharing actual code snippets).
- Don't over-explain. If the answer is simple, keep it simple.
- Match the user's message length roughly. If they send a short message, don't write an essay. But NEVER mirror rudeness, frustration, or negativity. Always stay polite, friendly, and helpful regardless of the user's tone. If they're upset, acknowledge it warmly and focus on solving their problem.
- If a user reports a problem vaguely, don't just mirror the vagueness back. Ask specific diagnostic questions (platform, what they were doing, what they see, error messages) to actually move toward a fix.
- When someone says they have a technical issue, ALWAYS ask at least 2 specific questions to narrow it down. Never respond with just "what's going on?" or "tell me more". Be a support engineer, not a greeter.
- If you reference Cap knowledge context below, weave it in naturally. Don't say "according to our documentation" or "based on our resources".
- Never make up features, pricing, dates, or technical details. If you're not sure, say so honestly. Always use the Cap Reference Guide below for accurate facts, URLs, and pricing.
- When linking to Cap pages, ALWAYS use the full URL from the reference guide (e.g. https://cap.so/download, not just "cap.so"). Get the exact URL right.
- If you genuinely can't help, say something like "I'm not sure on that one, let me get someone from the team to take a look" rather than stiff corporate escalation language.
- Keep responses focused, usually 1-2 short paragraphs max and under 120 words unless the user asks for detailed steps.
- Be genuinely helpful, personable, and respectful. You represent Cap and should leave the user feeling good about the interaction.
- ONLY discuss Cap and topics directly related to Cap (screen recording, sharing, account, billing, technical issues with Cap, etc.). If a user asks about other apps, competitors, or unrelated topics, politely steer the conversation back to Cap. Never recommend, compare, or discuss competing products or unrelated software.
- If you notice the conversation is going in circles, the user seems frustrated, or their issue isn't getting resolved after a few back-and-forth messages, offer to send it to the team if the support email tool is available. If the tool is unavailable, gently suggest emailing hello@cap.so for more hands-on help.`,
		supportEmailAvailable
			? `Support email tool:
- You can send one support email to hello@cap.so by using send_support_email, but only after the user explicitly asks you to send it or agrees to your offer.
- Never ask for, accept, or invent a sender or recipient email address. The server uses the signed-in account email automatically.
- Keep the email subject short and the body factual. Include the user's issue, useful details already shared, and what they need from the team.
- After the tool result, tell the user briefly whether it was sent. If the tool says rate_limited, say they can still email hello@cap.so directly.`
			: `Support email:
- You cannot send support email for this user in the current chat. If a hands-on review is needed, ask them to email hello@cap.so directly.`,
		CAP_REFERENCE_GUIDE,
		`The person you're talking to: ${userIdentity}`,
		context
			? `Additional context from knowledge base (use it to inform your answer naturally, don't quote it directly):\n${context}`
			: "",
	]
		.filter((line) => line.length > 0)
		.join("\n\n");

const mapHistoryForLlm = (history: ConversationMessage[]) =>
	history.slice(-20).map((message) => ({
		role: message.role === "user" ? ("user" as const) : ("assistant" as const),
		content: message.content.slice(0, 6000),
	}));

const parseAnthropicMessage = (payload: unknown) => {
	if (!payload || typeof payload !== "object") return null;
	const content = (payload as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;

	const blocks = content.flatMap((block): AnthropicResponseBlock[] => {
		if (!block || typeof block !== "object") return [];
		const type = (block as { type?: unknown }).type;
		if (type === "text") {
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? [{ type, text }] : [];
		}
		if (type === "tool_use") {
			const id = (block as { id?: unknown }).id;
			const name = (block as { name?: unknown }).name;
			if (typeof id !== "string" || typeof name !== "string") return [];
			return [
				{
					type,
					id,
					name,
					input: (block as { input?: unknown }).input,
				},
			];
		}
		return [];
	});
	if (!blocks.length) return null;

	const text = blocks
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n")
		.trim();

	return {
		content: blocks,
		text: text.length > 0 ? text : null,
	};
};

const readToolString = (input: unknown, key: keyof SupportEmailToolInput) => {
	if (!input || typeof input !== "object") return null;
	const value = (input as Record<string, unknown>)[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const readSupportEmailInput = (input: unknown) => {
	const subject = readToolString(input, "subject");
	const message = readToolString(input, "message");
	if (!subject || !message) return null;
	return {
		subject,
		message,
	};
};

const formatSupportEmailToolResult = (result: SupportEmailToolResult) => {
	if (result.status === "sent") {
		return `Support email sent to hello@cap.so from the user's account email. Remaining sends today: ${result.remainingToday}.`;
	}
	return "Support email was not sent because this user has reached the 2 emails per day limit.";
};

const fallbackReplyFromSupportEmailToolResults = (
	toolResults: SupportEmailExecutionResult[],
) => {
	const firstToolResult = toolResults[0];
	if (firstToolResult?.content.includes("Support email sent")) {
		return "Done, I sent that to the team from your account email. We'll follow up with you there.";
	}
	if (firstToolResult?.isError) {
		return "I couldn't send that to the team right now. Please email hello@cap.so directly.";
	}
	return "I couldn't send another support email from your account today. You're limited to 2 per day, but you can still email hello@cap.so directly.";
};

const executeSupportEmailTool = async ({
	name,
	input,
	supportEmailTool,
}: {
	name: string;
	input: unknown;
	supportEmailTool: SupportEmailTool;
}): Promise<SupportEmailExecutionResult> => {
	if (name !== supportEmailToolDefinition.name) {
		return {
			content: "Unknown tool.",
			isError: true,
		};
	}

	const parsedInput = readSupportEmailInput(input);
	if (!parsedInput) {
		return {
			content: "Missing subject or message.",
			isError: true,
		};
	}

	try {
		const result = await supportEmailTool.execute(parsedInput);
		return {
			content: formatSupportEmailToolResult(result),
		};
	} catch {
		return {
			content: "Failed to send support email.",
			isError: true,
		};
	}
};

const executeSupportEmailToolUse = async ({
	toolUse,
	supportEmailTool,
}: {
	toolUse: AnthropicToolUseBlock;
	supportEmailTool: SupportEmailTool;
}): Promise<AnthropicToolResultBlock> => {
	const result = await executeSupportEmailTool({
		name: toolUse.name,
		input: toolUse.input,
		supportEmailTool,
	});
	return {
		type: "tool_result",
		tool_use_id: toolUse.id,
		content: result.content,
		...(result.isError ? { is_error: true } : {}),
	};
};

const postAnthropicMessages = async ({
	key,
	systemPrompt,
	messages,
	tools,
	maxTokens = MESSENGER_MAX_TOKENS,
}: {
	key: string;
	systemPrompt: string;
	messages: Array<{
		role: "user" | "assistant";
		content: string | AnthropicResponseBlock[] | AnthropicToolResultBlock[];
	}>;
	tools?: [typeof supportEmailToolDefinition];
	maxTokens?: number;
}) => {
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: MESSENGER_ANTHROPIC_MODEL,
			max_tokens: maxTokens,
			system: systemPrompt,
			messages,
			tools,
		}),
		signal: AbortSignal.timeout(35000),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Anthropic chat failed: ${response.status} ${text}`);
	}

	const payload = await response.json();
	return parseAnthropicMessage(payload);
};

const callAnthropic = async ({
	systemPrompt,
	history,
	supportEmailTool,
}: {
	systemPrompt: string;
	history: ConversationMessage[];
	supportEmailTool: SupportEmailTool | null;
}) => {
	const key = serverEnv().ANTHROPIC_API_KEY;
	if (!key) return null;

	const initial = await postAnthropicMessages({
		key,
		systemPrompt,
		messages: mapHistoryForLlm(history),
		tools: supportEmailTool ? [supportEmailToolDefinition] : undefined,
		maxTokens: supportEmailTool
			? MESSENGER_TOOL_DISPATCH_MAX_TOKENS
			: MESSENGER_MAX_TOKENS,
	});

	if (!initial) return null;
	const toolUses = supportEmailTool
		? initial.content.filter(
				(block): block is AnthropicToolUseBlock => block.type === "tool_use",
			)
		: [];

	if (!supportEmailTool || toolUses.length === 0) {
		return initial.text;
	}

	const toolResults: AnthropicToolResultBlock[] = [];
	let sentEmailToolResult = false;
	for (const toolUse of toolUses) {
		if (sentEmailToolResult) {
			toolResults.push({
				type: "tool_result",
				tool_use_id: toolUse.id,
				content: "Only one support email can be sent per assistant response.",
				is_error: true,
			});
			continue;
		}
		toolResults.push(
			await executeSupportEmailToolUse({ toolUse, supportEmailTool }),
		);
		sentEmailToolResult = true;
	}

	const final = await postAnthropicMessages({
		key,
		systemPrompt,
		messages: [
			...mapHistoryForLlm(history),
			{
				role: "assistant",
				content: initial.content,
			},
			{
				role: "user",
				content: toolResults,
			},
		],
	}).catch(() => null);

	if (final?.text) return final.text;
	return fallbackReplyFromSupportEmailToolResults(
		toolResults.map((result) => ({
			content: result.content,
			isError: result.is_error,
		})),
	);
};

const parseOpenAiCompatibleToolCalls = (message: { tool_calls?: unknown }) => {
	if (!Array.isArray(message.tool_calls)) return [];

	return message.tool_calls.flatMap(
		(toolCall): ChatCompletionMessageToolCall[] => {
			if (!toolCall || typeof toolCall !== "object") return [];
			const id = (toolCall as { id?: unknown }).id;
			const type = (toolCall as { type?: unknown }).type;
			const fn = (toolCall as { function?: unknown }).function;
			if (typeof id !== "string" || type !== "function") return [];
			if (!fn || typeof fn !== "object") return [];
			const name = (fn as { name?: unknown }).name;
			const args = (fn as { arguments?: unknown }).arguments;
			if (typeof name !== "string" || typeof args !== "string") return [];
			return [
				{
					id,
					type,
					function: {
						name,
						arguments: args,
					},
				},
			];
		},
	);
};

const parseOpenAiCompatibleMessage = (payload: unknown) => {
	if (!payload || typeof payload !== "object") return null;
	const choices = (payload as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0] as {
		message?: {
			content?: unknown;
			tool_calls?: unknown;
		};
	};
	const message = first.message;
	if (!message) return null;
	const content =
		typeof message.content === "string" ? message.content.trim() : "";
	const toolCalls = parseOpenAiCompatibleToolCalls(message);
	if (!content && toolCalls.length === 0) return null;
	return {
		text: content.length > 0 ? content : null,
		toolCalls,
	};
};

const parseOpenAiToolInput = (args: string) => {
	try {
		return JSON.parse(args) as unknown;
	} catch {
		return null;
	}
};

const executeOpenAiCompatibleToolCalls = async ({
	toolCalls,
	supportEmailTool,
}: {
	toolCalls: ChatCompletionMessageToolCall[];
	supportEmailTool: SupportEmailTool;
}) => {
	const toolResults: Array<
		SupportEmailExecutionResult & { toolCall: ChatCompletionMessageToolCall }
	> = [];
	let sentEmailToolResult = false;

	for (const toolCall of toolCalls) {
		if (sentEmailToolResult) {
			toolResults.push({
				toolCall,
				content: "Only one support email can be sent per assistant response.",
				isError: true,
			});
			continue;
		}

		toolResults.push({
			toolCall,
			...(await executeSupportEmailTool({
				name: toolCall.function.name,
				input: parseOpenAiToolInput(toolCall.function.arguments),
				supportEmailTool,
			})),
		});
		sentEmailToolResult = true;
	}

	return toolResults;
};

const runOpenAiCompatibleToolLoop = async ({
	systemPrompt,
	history,
	supportEmailTool,
	createCompletion,
}: {
	systemPrompt: string;
	history: ConversationMessage[];
	supportEmailTool: SupportEmailTool | null;
	createCompletion: ({
		messages,
		tools,
		maxTokens,
	}: {
		messages: ChatCompletionMessageParam[];
		tools?: ChatCompletionTool[];
		maxTokens: number;
	}) => Promise<ReturnType<typeof parseOpenAiCompatibleMessage>>;
}) => {
	const messages: ChatCompletionMessageParam[] = [
		{ role: "system", content: systemPrompt },
		...mapHistoryForLlm(history),
	];

	const initial = await createCompletion({
		messages,
		tools: supportEmailTool
			? [openAiCompatibleSupportEmailToolDefinition]
			: undefined,
		maxTokens: supportEmailTool
			? MESSENGER_TOOL_DISPATCH_MAX_TOKENS
			: MESSENGER_MAX_TOKENS,
	});

	if (!initial) return null;
	if (!supportEmailTool || initial.toolCalls.length === 0) {
		return initial.text;
	}

	const toolResults = await executeOpenAiCompatibleToolCalls({
		toolCalls: initial.toolCalls,
		supportEmailTool,
	});
	const assistantMessage: ChatCompletionAssistantMessageParam = {
		role: "assistant",
		content: initial.text,
		tool_calls: initial.toolCalls,
	};
	const final = await createCompletion({
		messages: [
			...messages,
			assistantMessage,
			...toolResults.map(
				(result): ChatCompletionMessageParam => ({
					role: "tool",
					tool_call_id: result.toolCall.id,
					content: result.content,
				}),
			),
		],
		maxTokens: MESSENGER_MAX_TOKENS,
	}).catch(() => null);

	if (final?.text) return final.text;
	return fallbackReplyFromSupportEmailToolResults(toolResults);
};

const callOpenAi = async ({
	systemPrompt,
	history,
	supportEmailTool,
}: {
	systemPrompt: string;
	history: ConversationMessage[];
	supportEmailTool: SupportEmailTool | null;
}) => {
	const key = serverEnv().OPENAI_API_KEY;
	if (!key) return null;

	return runOpenAiCompatibleToolLoop({
		systemPrompt,
		history,
		supportEmailTool,
		createCompletion: async ({ messages, tools, maxTokens }) => {
			const response = await fetch(
				"https://api.openai.com/v1/chat/completions",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: "gpt-4o-mini",
						temperature: 0.65,
						max_tokens: maxTokens,
						messages,
						tools,
						tool_choice: tools ? "auto" : undefined,
						parallel_tool_calls: tools ? false : undefined,
					}),
					signal: AbortSignal.timeout(35000),
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`OpenAI chat failed: ${response.status} ${text}`);
			}

			const payload = await response.json();
			return parseOpenAiCompatibleMessage(payload);
		},
	});
};

const callGroq = async ({
	systemPrompt,
	history,
	supportEmailTool,
}: {
	systemPrompt: string;
	history: ConversationMessage[];
	supportEmailTool: SupportEmailTool | null;
}) => {
	const client = getGroqClient();
	if (!client) return null;

	return runOpenAiCompatibleToolLoop({
		systemPrompt,
		history,
		supportEmailTool,
		createCompletion: async ({ messages, tools, maxTokens }) => {
			const completion = await client.chat.completions.create({
				model: GROQ_MODEL,
				temperature: 0.65,
				max_tokens: maxTokens,
				messages,
				tools,
				tool_choice: tools ? "auto" : undefined,
				parallel_tool_calls: tools ? false : undefined,
			});
			return parseOpenAiCompatibleMessage(completion);
		},
	});
};

export const generateMessengerAgentReply = async ({
	userIdentity,
	identityTag,
	query,
	history,
	supportEmailTool = null,
}: {
	userIdentity: string;
	identityTag: string;
	query: string;
	history: ConversationMessage[];
	supportEmailTool?: SupportEmailTool | null;
}) => {
	const [personalContext, knowledgeContext] = await Promise.all([
		searchSupermemory({ query, containerTag: identityTag, limit: 4 }).catch(
			() => [],
		),
		searchSupermemory({
			query,
			containerTag: getKnowledgeTag(),
			limit: 4,
		}).catch(() => []),
	]);

	const systemPrompt = buildSystemPrompt({
		userIdentity,
		context: normalizeContext([...knowledgeContext, ...personalContext]),
		supportEmailAvailable: Boolean(supportEmailTool),
	});

	const fromAnthropic = await callAnthropic({
		systemPrompt,
		history,
		supportEmailTool,
	}).catch(() => null);
	if (fromAnthropic) return fromAnthropic;

	const fromOpenAi = await callOpenAi({
		systemPrompt,
		history,
		supportEmailTool,
	}).catch(() => null);
	if (fromOpenAi) return fromOpenAi;

	const fromGroq = await callGroq({
		systemPrompt,
		history,
		supportEmailTool,
	}).catch(() => null);
	if (fromGroq) return fromGroq;

	return "Oh no, I'm so sorry about this! I'm having a little technical hiccup on my end. Someone from the team will jump in here shortly to help you out though!";
};
