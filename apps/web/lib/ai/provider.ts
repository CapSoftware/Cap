import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { serverEnv } from "@cap/env";
import type { JSONValue, LanguageModel } from "ai";

export type AiProviderId =
	| "assemblyai"
	| "openai"
	| "anthropic"
	| "groq"
	| "openai-compatible";

export type AiModelRole = "generation" | "chat" | "chat-streaming";

type AiSdkProviderOptions = Record<string, Record<string, JSONValue>>;

export interface AiModelOptions {
	/**
	 * Ask the provider to repair malformed JSON output (AssemblyAI LLM
	 * gateway only — its gpt-oss models reject `response_format`). Only set
	 * this for calls that expect a JSON response; the repair step would
	 * mangle plain-text output.
	 */
	jsonRepair?: boolean;
}

export interface AiModelSelection {
	provider: AiProviderId;
	modelId: string;
	/**
	 * Lazily creates the language model. Call this where the request is
	 * made (eg. inside a workflow step) — model instances must never cross
	 * a workflow "use step" boundary.
	 */
	model: (options?: AiModelOptions) => LanguageModel;
	supportsStreaming: boolean;
	supportsTemperature: boolean;
	defaultMaxOutputTokens: number;
	/**
	 * Provider options that disable parallel tool calls. Pass to
	 * `generateText` only when tools are supplied — some providers reject
	 * the underlying parameter without tools. Undefined for providers with
	 * no such option (callers must guard inside tool `execute` instead).
	 */
	providerOptions?: AiSdkProviderOptions;
}

const ASSEMBLYAI_GATEWAY_BASE_URL = "https://llm-gateway.assemblyai.com/v1";

const ROLE_MAX_OUTPUT_TOKENS: Record<AiModelRole, number> = {
	generation: 8000,
	chat: 512,
	// Generous relative to the ~800-token answers we expect: on models with
	// thinking on by default (eg. claude-sonnet-5) the cap covers thinking
	// AND visible text, and a tight cap can leave an empty visible answer.
	"chat-streaming": 2000,
};

const DEFAULT_MODELS: Record<
	Exclude<AiProviderId, "openai-compatible">,
	Record<AiModelRole, string>
> = {
	assemblyai: {
		generation: "gpt-oss-120b",
		// Not claude-sonnet-5: it thinks by default and thinking shares the
		// (small) chat token budget, which can leave an empty visible reply
		// through the gateway. Override with AI_CHAT_MODEL to change.
		chat: "claude-sonnet-4-6",
		// The AssemblyAI gateway only streams OpenAI-family models.
		"chat-streaming": "gpt-5-mini",
	},
	groq: {
		generation: "openai/gpt-oss-120b",
		chat: "openai/gpt-oss-120b",
		"chat-streaming": "openai/gpt-oss-120b",
	},
	openai: {
		generation: "gpt-4o-mini",
		chat: "gpt-4o-mini",
		"chat-streaming": "gpt-4o-mini",
	},
	anthropic: {
		generation: "claude-haiku-4-5",
		chat: "claude-sonnet-5",
		"chat-streaming": "claude-sonnet-5",
	},
};

// `assemblyai` is intentionally absent: it is never auto-detected, so
// transcription-only instances don't silently start incurring LLM charges.
// The order is per role to preserve each feature's historical primary
// provider when `AI_PROVIDER` is unset: generation ran on Groq first, while
// the chat features (messenger, docs Ask AI) ran on Anthropic first.
const AUTO_DETECT_ORDER: Record<AiModelRole, readonly AiProviderId[]> = {
	generation: ["groq", "openai", "anthropic", "openai-compatible"],
	chat: ["anthropic", "openai", "groq", "openai-compatible"],
	"chat-streaming": ["anthropic", "openai", "groq", "openai-compatible"],
};

function isProviderConfigured(provider: AiProviderId): boolean {
	const env = serverEnv();
	switch (provider) {
		case "assemblyai":
			return Boolean(env.ASSEMBLY_API_KEY);
		case "openai":
			return Boolean(env.OPENAI_API_KEY);
		case "anthropic":
			return Boolean(env.ANTHROPIC_API_KEY);
		case "groq":
			return Boolean(env.GROQ_API_KEY);
		case "openai-compatible":
			return Boolean(env.AI_BASE_URL && env.AI_MODEL);
	}
}

function missingCredentialHint(provider: AiProviderId): string {
	switch (provider) {
		case "assemblyai":
			return "ASSEMBLY_API_KEY is not set";
		case "openai":
			return "OPENAI_API_KEY is not set";
		case "anthropic":
			return "ANTHROPIC_API_KEY is not set";
		case "groq":
			return "GROQ_API_KEY is not set";
		case "openai-compatible":
			return "AI_BASE_URL and AI_MODEL are required";
	}
}

export function getConfiguredAiProviders(
	role: AiModelRole = "generation",
): AiProviderId[] {
	const explicit = serverEnv().AI_PROVIDER;
	const providers: AiProviderId[] = [];

	if (explicit) {
		if (isProviderConfigured(explicit)) {
			providers.push(explicit);
		} else {
			console.warn(
				`[ai] AI_PROVIDER is set to "${explicit}" but it is not usable (${missingCredentialHint(explicit)}); falling back to auto-detected providers`,
			);
		}
	}

	for (const provider of AUTO_DETECT_ORDER[role]) {
		if (providers.includes(provider)) continue;
		// AI_BASE_URL belongs to the AssemblyAI gateway when it is the
		// explicit provider — don't auto-detect a second provider from it.
		if (provider === "openai-compatible" && explicit === "assemblyai") continue;
		if (!isProviderConfigured(provider)) continue;
		providers.push(provider);
	}

	return providers;
}

export function isAiConfigured(): boolean {
	return getConfiguredAiProviders().length > 0;
}

function envModelOverride(role: AiModelRole): string | undefined {
	const env = serverEnv();
	switch (role) {
		case "generation":
			return env.AI_MODEL;
		case "chat":
			return env.AI_CHAT_MODEL;
		case "chat-streaming":
			return env.AI_STREAM_MODEL;
	}
}

function openAiCompatibleModelId(role: AiModelRole): string | undefined {
	const env = serverEnv();
	switch (role) {
		case "generation":
			return env.AI_MODEL;
		case "chat":
			return env.AI_CHAT_MODEL ?? env.AI_MODEL;
		case "chat-streaming":
			return env.AI_STREAM_MODEL ?? env.AI_CHAT_MODEL ?? env.AI_MODEL;
	}
}

function resolveModelId(
	provider: AiProviderId,
	role: AiModelRole,
): string | undefined {
	if (provider === "openai-compatible") return openAiCompatibleModelId(role);
	// The AI_MODEL / AI_CHAT_MODEL / AI_STREAM_MODEL overrides name models
	// for the explicitly selected provider only — fallback providers keep
	// their own defaults so the fallback chain stays valid.
	const override =
		serverEnv().AI_PROVIDER === provider ? envModelOverride(role) : undefined;
	return override ?? DEFAULT_MODELS[provider][role];
}

function createModel(
	provider: AiProviderId,
	modelId: string,
	options?: AiModelOptions,
): LanguageModel {
	const env = serverEnv();
	switch (provider) {
		case "groq":
			return createGroq({ apiKey: env.GROQ_API_KEY })(modelId);
		case "openai":
			// `.chat` — the provider defaults to the Responses API otherwise.
			return createOpenAI({ apiKey: env.OPENAI_API_KEY }).chat(modelId);
		case "anthropic":
			return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(modelId);
		case "assemblyai":
			return createOpenAICompatible({
				name: "assemblyai",
				baseURL: env.AI_BASE_URL ?? ASSEMBLYAI_GATEWAY_BASE_URL,
				apiKey: env.ASSEMBLY_API_KEY,
				supportsStructuredOutputs: false,
				...(options?.jsonRepair
					? {
							transformRequestBody: (body) => ({
								...body,
								post_processing_steps: [{ type: "json-repair" }],
							}),
						}
					: {}),
			})(modelId);
		case "openai-compatible": {
			const baseURL = env.AI_BASE_URL;
			if (!baseURL) {
				throw new Error(
					"AI_BASE_URL must be set to use the openai-compatible AI provider",
				);
			}
			return createOpenAICompatible({
				name: "openai-compatible",
				baseURL,
				apiKey: env.AI_API_KEY,
			})(modelId);
		}
	}
}

function parallelToolCallProviderOptions(
	provider: AiProviderId,
): AiSdkProviderOptions | undefined {
	switch (provider) {
		case "openai":
			return { openai: { parallelToolCalls: false } };
		case "groq":
			return { groq: { parallelToolCalls: false } };
		case "anthropic":
			return { anthropic: { disableParallelToolUse: true } };
		default:
			return undefined;
	}
}

function supportsStreaming(provider: AiProviderId, modelId: string): boolean {
	// The AssemblyAI LLM gateway only streams OpenAI-family models.
	if (provider === "assemblyai") return modelId.startsWith("gpt");
	return true;
}

function supportsTemperature(provider: AiProviderId, modelId: string): boolean {
	// gpt-5 and OpenAI o-series reasoning models reject `temperature`.
	const bareModelId = modelId.split("/").pop() ?? modelId;
	if (/^(gpt-5|o\d)/.test(bareModelId)) return false;
	// The AssemblyAI gateway rejects `temperature` for Claude models
	// (400: "model claude-sonnet-5 does not support temperature"); it
	// accepts it for gpt-oss and Gemini models.
	if (provider === "assemblyai" && bareModelId.startsWith("claude"))
		return false;
	return true;
}

export function getAiProviderChain(role: AiModelRole): AiModelSelection[] {
	const selections: AiModelSelection[] = [];

	for (const provider of getConfiguredAiProviders(role)) {
		const modelId = resolveModelId(provider, role);
		if (!modelId) continue;

		selections.push({
			provider,
			modelId,
			model: (options) => createModel(provider, modelId, options),
			supportsStreaming: supportsStreaming(provider, modelId),
			supportsTemperature: supportsTemperature(provider, modelId),
			defaultMaxOutputTokens: ROLE_MAX_OUTPUT_TOKENS[role],
			providerOptions: parallelToolCallProviderOptions(provider),
		});
	}

	if (role === "chat-streaming") {
		return selections.filter((selection) => selection.supportsStreaming);
	}

	return selections;
}

export function getAiModel(role: AiModelRole): AiModelSelection | null {
	return getAiProviderChain(role)[0] ?? null;
}
