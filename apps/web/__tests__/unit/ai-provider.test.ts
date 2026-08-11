import { describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

import {
	getAiModel,
	getAiProviderChain,
	getConfiguredAiProviders,
	isAiConfigured,
} from "@/lib/ai/provider";

const envWith = (env: Record<string, string | undefined>) => {
	serverEnvMock.mockReturnValue(env);
};

describe("getConfiguredAiProviders", () => {
	it("auto-detects generation providers by key presence in order groq, openai, anthropic", () => {
		envWith({
			GROQ_API_KEY: "groq-key",
			OPENAI_API_KEY: "openai-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		expect(getConfiguredAiProviders()).toEqual(["groq", "openai", "anthropic"]);
		expect(getConfiguredAiProviders("generation")).toEqual([
			"groq",
			"openai",
			"anthropic",
		]);
	});

	it("auto-detects chat providers anthropic-first, preserving each feature's historical primary", () => {
		envWith({
			GROQ_API_KEY: "groq-key",
			OPENAI_API_KEY: "openai-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		expect(getConfiguredAiProviders("chat")).toEqual([
			"anthropic",
			"openai",
			"groq",
		]);
		expect(getConfiguredAiProviders("chat-streaming")).toEqual([
			"anthropic",
			"openai",
			"groq",
		]);
	});

	it("puts the explicit AI_PROVIDER first for every role", () => {
		envWith({
			AI_PROVIDER: "groq",
			GROQ_API_KEY: "groq-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		expect(getConfiguredAiProviders("chat")).toEqual(["groq", "anthropic"]);
	});

	it("puts the explicit AI_PROVIDER first and appends the rest", () => {
		envWith({
			AI_PROVIDER: "anthropic",
			GROQ_API_KEY: "groq-key",
			OPENAI_API_KEY: "openai-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		expect(getConfiguredAiProviders()).toEqual(["anthropic", "groq", "openai"]);
	});

	it("never auto-detects assemblyai even when ASSEMBLY_API_KEY is set", () => {
		envWith({
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
		});

		expect(getConfiguredAiProviders()).toEqual(["groq"]);
	});

	it("puts assemblyai first when explicitly selected and keeps the fallback chain", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
			OPENAI_API_KEY: "openai-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		expect(getConfiguredAiProviders()).toEqual([
			"assemblyai",
			"groq",
			"openai",
			"anthropic",
		]);
	});

	it("warns and falls through when the explicit provider is missing credentials", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		envWith({
			AI_PROVIDER: "assemblyai",
			GROQ_API_KEY: "groq-key",
		});

		expect(getConfiguredAiProviders()).toEqual(["groq"]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('AI_PROVIDER is set to "assemblyai"'),
		);
	});

	it("auto-detects openai-compatible when AI_BASE_URL and AI_MODEL are set", () => {
		envWith({
			GROQ_API_KEY: "groq-key",
			AI_BASE_URL: "http://localhost:11434/v1",
			AI_MODEL: "llama3.3",
		});

		expect(getConfiguredAiProviders()).toEqual(["groq", "openai-compatible"]);
	});

	it("does not auto-detect openai-compatible from an explicit assemblyai gateway url", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			AI_BASE_URL: "https://llm-gateway.eu.assemblyai.com/v1",
			AI_MODEL: "claude-sonnet-5",
		});

		expect(getConfiguredAiProviders()).toEqual(["assemblyai"]);
	});
});

describe("isAiConfigured", () => {
	it("is false without any provider credentials", () => {
		envWith({});
		expect(isAiConfigured()).toBe(false);
	});

	it("is false with only ASSEMBLY_API_KEY and no explicit opt-in", () => {
		envWith({ ASSEMBLY_API_KEY: "assembly-key" });
		expect(isAiConfigured()).toBe(false);
	});

	it("is true when assemblyai is explicitly opted into", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
		});
		expect(isAiConfigured()).toBe(true);
	});

	it("is true with an auto-detectable key", () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		expect(isAiConfigured()).toBe(true);
	});
});

describe("role model defaults", () => {
	it("uses the assemblyai defaults per role", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
		});

		expect(getAiModel("generation")?.modelId).toBe("gpt-oss-120b");
		expect(getAiModel("chat")?.modelId).toBe("claude-sonnet-4-6");
		expect(getAiModel("chat-streaming")?.modelId).toBe("gpt-5-mini");
	});

	it("uses the groq defaults per role", () => {
		envWith({ GROQ_API_KEY: "groq-key" });

		expect(getAiModel("generation")?.modelId).toBe("openai/gpt-oss-120b");
		expect(getAiModel("chat")?.modelId).toBe("openai/gpt-oss-120b");
		expect(getAiModel("chat-streaming")?.modelId).toBe("openai/gpt-oss-120b");
	});

	it("uses the openai defaults per role", () => {
		envWith({ OPENAI_API_KEY: "openai-key" });

		expect(getAiModel("generation")?.modelId).toBe("gpt-4o-mini");
		expect(getAiModel("chat")?.modelId).toBe("gpt-4o-mini");
		expect(getAiModel("chat-streaming")?.modelId).toBe("gpt-4o-mini");
	});

	it("uses the anthropic defaults per role", () => {
		envWith({ ANTHROPIC_API_KEY: "anthropic-key" });

		expect(getAiModel("generation")?.modelId).toBe("claude-haiku-4-5");
		expect(getAiModel("chat")?.modelId).toBe("claude-sonnet-5");
		expect(getAiModel("chat-streaming")?.modelId).toBe("claude-sonnet-5");
	});

	it("sets the default max output tokens per role", () => {
		envWith({ GROQ_API_KEY: "groq-key" });

		expect(getAiModel("generation")?.defaultMaxOutputTokens).toBe(8000);
		expect(getAiModel("chat")?.defaultMaxOutputTokens).toBe(512);
		expect(getAiModel("chat-streaming")?.defaultMaxOutputTokens).toBe(2000);
	});

	it("lazily constructs models with the selected model id", () => {
		envWith({ OPENAI_API_KEY: "openai-key" });

		const selection = getAiModel("generation");
		const model = selection?.model() as { modelId?: string } | undefined;
		expect(model?.modelId).toBe("gpt-4o-mini");
	});
});

describe("env model overrides", () => {
	it("applies per-role overrides to the explicit provider", () => {
		envWith({
			AI_PROVIDER: "groq",
			GROQ_API_KEY: "groq-key",
			AI_MODEL: "generation-model",
			AI_CHAT_MODEL: "chat-model",
			AI_STREAM_MODEL: "stream-model",
		});

		expect(getAiModel("generation")?.modelId).toBe("generation-model");
		expect(getAiModel("chat")?.modelId).toBe("chat-model");
		expect(getAiModel("chat-streaming")?.modelId).toBe("stream-model");
	});

	it("does not leak overrides into fallback providers", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
			AI_MODEL: "custom-model",
		});

		const chain = getAiProviderChain("generation");
		expect(chain[0]?.provider).toBe("assemblyai");
		expect(chain[0]?.modelId).toBe("custom-model");
		expect(chain[1]?.provider).toBe("groq");
		expect(chain[1]?.modelId).toBe("openai/gpt-oss-120b");
	});

	it("cascades openai-compatible role models from AI_MODEL", () => {
		envWith({
			AI_PROVIDER: "openai-compatible",
			AI_BASE_URL: "http://localhost:11434/v1",
			AI_MODEL: "base-model",
		});

		expect(getAiModel("generation")?.modelId).toBe("base-model");
		expect(getAiModel("chat")?.modelId).toBe("base-model");
		expect(getAiModel("chat-streaming")?.modelId).toBe("base-model");
	});

	it("cascades openai-compatible streaming models through AI_CHAT_MODEL", () => {
		envWith({
			AI_PROVIDER: "openai-compatible",
			AI_BASE_URL: "http://localhost:11434/v1",
			AI_MODEL: "base-model",
			AI_CHAT_MODEL: "chat-model",
		});

		expect(getAiModel("chat")?.modelId).toBe("chat-model");
		expect(getAiModel("chat-streaming")?.modelId).toBe("chat-model");
	});
});

describe("streaming capability", () => {
	it("keeps assemblyai in the chat-streaming chain for OpenAI-family models", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
		});

		const chain = getAiProviderChain("chat-streaming");
		expect(chain[0]?.provider).toBe("assemblyai");
		expect(chain[0]?.supportsStreaming).toBe(true);
	});

	it("filters assemblyai out of the chat-streaming chain for non-OpenAI models", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			AI_STREAM_MODEL: "claude-sonnet-5",
			GROQ_API_KEY: "groq-key",
		});

		const chain = getAiProviderChain("chat-streaming");
		expect(chain.map((selection) => selection.provider)).toEqual(["groq"]);

		// The non-streaming selection still exists for non-streaming roles.
		expect(getAiProviderChain("chat")[0]?.provider).toBe("assemblyai");
	});
});

describe("supportsTemperature", () => {
	it("is false for gpt-5 family models", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
		});

		expect(getAiModel("chat-streaming")?.modelId).toBe("gpt-5-mini");
		expect(getAiModel("chat-streaming")?.supportsTemperature).toBe(false);
	});

	it("is true for gpt-oss models", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
		});

		expect(getAiModel("generation")?.supportsTemperature).toBe(true);
		expect(getAiProviderChain("generation")[1]?.supportsTemperature).toBe(true);
	});

	it("is false for claude models on the assemblyai gateway but true on anthropic", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		const chain = getAiProviderChain("chat");
		expect(chain[0]?.provider).toBe("assemblyai");
		expect(chain[0]?.modelId).toBe("claude-sonnet-4-6");
		// The gateway 400s on temperature for claude models
		expect(chain[0]?.supportsTemperature).toBe(false);
		expect(chain[1]?.provider).toBe("anthropic");
		expect(chain[1]?.supportsTemperature).toBe(true);
	});
});

describe("provider options", () => {
	it("exposes parallel tool call disabling options per provider", () => {
		envWith({
			AI_PROVIDER: "assemblyai",
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
			OPENAI_API_KEY: "openai-key",
			ANTHROPIC_API_KEY: "anthropic-key",
		});

		const chain = getAiProviderChain("chat");
		const byProvider = Object.fromEntries(
			chain.map((selection) => [selection.provider, selection.providerOptions]),
		);

		expect(byProvider.assemblyai).toBeUndefined();
		expect(byProvider.groq).toEqual({ groq: { parallelToolCalls: false } });
		expect(byProvider.openai).toEqual({
			openai: { parallelToolCalls: false },
		});
		expect(byProvider.anthropic).toEqual({
			anthropic: { disableParallelToolUse: true },
		});
	});
});
