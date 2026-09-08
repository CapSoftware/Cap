import "server-only";

import type { MessengerMessageRole } from "@cap/database/schema";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { runWithAiProviders } from "@/lib/ai/run";
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

type SupportEmailExecutionResult = {
	content: string;
	isError?: boolean;
};

const MESSENGER_MAX_TOKENS = 350;
const MESSENGER_TOOL_DISPATCH_MAX_TOKENS = 512;

const MESSENGER_APOLOGY_REPLY =
	"Oh no, I'm so sorry about this! I'm having a little technical hiccup on my end. Someone from the team will jump in here shortly to help you out though!";

const normalizeContext = (sections: string[]) =>
	sections
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.slice(0, 6)
		.join("\n\n")
		.slice(0, 7000);

// zod strips unknown keys (like a spoofed `email`) before `execute` runs;
// the server alone controls sender, recipient, and reply-to.
const supportEmailInputSchema = z.object({
	subject: z.string().describe("A concise support email subject."),
	message: z
		.string()
		.describe(
			"A concise support email body summarizing the user's issue and relevant context from the chat.",
		),
});

const SUPPORT_EMAIL_TOOL_NAME = "send_support_email";
const SUPPORT_EMAIL_TOOL_DESCRIPTION =
	"Send a concise support email to the Cap team after the signed-in user explicitly asks or agrees. The server controls the recipient, sender, reply-to address, account email, conversation id, and rate limit.";

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
	input,
	supportEmailTool,
}: {
	input: unknown;
	supportEmailTool: SupportEmailTool;
}): Promise<SupportEmailExecutionResult> => {
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

	// Shared across providers on purpose: once a support email attempt has
	// happened, no other provider may retry the turn (`stopOnError` below).
	const state: {
		sent: boolean;
		toolResults: SupportEmailExecutionResult[];
	} = { sent: false, toolResults: [] };

	const tools = supportEmailTool
		? {
				[SUPPORT_EMAIL_TOOL_NAME]: tool({
					description: SUPPORT_EMAIL_TOOL_DESCRIPTION,
					inputSchema: supportEmailInputSchema,
					execute: async (input) => {
						// In-execute latch: providers without a parallel-tool-call
						// switch (eg. the AssemblyAI gateway) can emit several tool
						// calls in one step; only the first may send an email.
						if (state.sent) {
							const result: SupportEmailExecutionResult = {
								content:
									"Only one support email can be sent per assistant response.",
								isError: true,
							};
							state.toolResults.push(result);
							return result.content;
						}
						state.sent = true;

						const result = await executeSupportEmailTool({
							input,
							supportEmailTool,
						});
						state.toolResults.push(result);
						return result.content;
					},
				}),
			}
		: undefined;

	try {
		return await runWithAiProviders(
			"chat",
			async (selection) => {
				const result = await generateText({
					model: selection.model(),
					system: systemPrompt,
					messages: mapHistoryForLlm(history),
					maxOutputTokens: supportEmailTool
						? MESSENGER_TOOL_DISPATCH_MAX_TOKENS
						: MESSENGER_MAX_TOKENS,
					// Parity with the previous per-provider implementations: the
					// raw Anthropic calls never sent temperature.
					...(selection.supportsTemperature &&
					selection.provider !== "anthropic"
						? { temperature: 0.65 }
						: {}),
					abortSignal: AbortSignal.timeout(35000),
					...(tools
						? {
								tools,
								stopWhen: stepCountIs(2),
								...(selection.providerOptions
									? { providerOptions: selection.providerOptions }
									: {}),
							}
						: {}),
				});

				const text = result.text.trim();
				if (text) return text;
				if (state.toolResults.length > 0) {
					return fallbackReplyFromSupportEmailToolResults(state.toolResults);
				}
				throw new Error("Messenger agent returned an empty reply");
			},
			{ stopOnError: () => state.sent },
		);
	} catch {
		if (state.toolResults.length > 0) {
			return fallbackReplyFromSupportEmailToolResults(state.toolResults);
		}
		return MESSENGER_APOLOGY_REPLY;
	}
};
