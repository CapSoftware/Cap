import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";

const getAiProviderChainMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
}));

import { AiUnavailableError, runWithAiProviders } from "@/lib/ai/run";

const makeSelection = (provider: string): AiModelSelection => ({
	provider: provider as AiModelSelection["provider"],
	modelId: `${provider}-model`,
	model: () => {
		throw new Error("model should not be constructed in these tests");
	},
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 8000,
});

describe("runWithAiProviders", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("returns the first successful result without touching later providers", async () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
		const run = vi.fn().mockResolvedValue("first");

		await expect(runWithAiProviders("generation", run)).resolves.toBe("first");
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]?.provider).toBe("groq");
	});

	it("falls through to the next provider on failure", async () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("groq down"))
			.mockResolvedValueOnce("second");

		await expect(runWithAiProviders("generation", run)).resolves.toBe("second");
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1]?.[0]?.provider).toBe("openai");
	});

	it("stops and rethrows when stopOnError returns true", async () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
		const failure = new Error("side effect already happened");
		const run = vi.fn().mockRejectedValue(failure);

		await expect(
			runWithAiProviders("chat", run, { stopOnError: () => true }),
		).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports provider errors through onProviderError", async () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
		const failure = new Error("groq down");
		const run = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce("second");
		const onProviderError = vi.fn();

		await runWithAiProviders("generation", run, { onProviderError });

		expect(onProviderError).toHaveBeenCalledTimes(1);
		expect(onProviderError.mock.calls[0]?.[0]).toBe(failure);
		expect(onProviderError.mock.calls[0]?.[1]?.provider).toBe("groq");
	});

	it("throws AiUnavailableError when no provider is configured", async () => {
		getAiProviderChainMock.mockReturnValue([]);
		const run = vi.fn();

		await expect(runWithAiProviders("generation", run)).rejects.toThrowError(
			AiUnavailableError,
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("throws AiUnavailableError with the last error when every provider fails", async () => {
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
		const lastFailure = new Error("openai down");
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("groq down"))
			.mockRejectedValueOnce(lastFailure);

		const promise = runWithAiProviders("generation", run);
		await expect(promise).rejects.toThrowError(AiUnavailableError);
		await promise.catch((error) => {
			expect((error as AiUnavailableError).cause).toBe(lastFailure);
		});
		expect(run).toHaveBeenCalledTimes(2);
	});
});
