import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realAssemblyAIResponse } from "../fixtures/assemblyai-responses";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

import { createAssemblyAIClient } from "@/lib/assemblyai";

const fetchMock = vi.fn(
	async (_input: string, _init?: RequestInit) =>
		new Response(JSON.stringify(realAssemblyAIResponse)),
);

describe("createAssemblyAIClient", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fetchMock.mockClear();
	});

	it.each([
		[undefined, "https://api.assemblyai.com"],
		["", "https://api.assemblyai.com"],
		["https://api.eu.assemblyai.com", "https://api.eu.assemblyai.com"],
		["https://api.eu.assemblyai.com/", "https://api.eu.assemblyai.com"],
	])("ASSEMBLY_BASE_URL=%s sends requests to %s", async (baseUrl, host) => {
		serverEnvMock.mockReturnValue({
			ASSEMBLY_API_KEY: "key",
			ASSEMBLY_BASE_URL: baseUrl,
		});

		await createAssemblyAIClient().transcripts.get(realAssemblyAIResponse.id);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`${host}/v2/transcript/${realAssemblyAIResponse.id}`,
		);
	});
});
