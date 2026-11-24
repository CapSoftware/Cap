import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>,
}));

vi.mock("@cap/env", () => ({ serverEnv: () => mocks.env }));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => false,
	getAiProviderChain: () => [],
}));
vi.mock("ai", () => ({ gateway: (id: string) => `gateway:${id}` }));

const config = await import("@/lib/meetings/ai-config");

const EDGE = "https://edge-config.vercel.com/ecfg_abc123?token=tok-1";

beforeEach(() => {
	mocks.env = {};
	config.resetMeetingsAiConfigCache();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("getMeetingsAiConfig", () => {
	it("uses gpt-6-luna and three free meetings by default", async () => {
		const value = await config.getMeetingsAiConfig();
		expect(value).toEqual(config.MEETINGS_AI_DEFAULTS);
		expect(value.notesModels).toEqual(["openai/gpt-6-luna"]);
		expect(value.trialMeetings).toBe(3);
	});

	it("layers Edge Config over the env overrides", async () => {
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({
			askModels: ["openai/gpt-6-luna-fast"],
			trialMeetings: 5,
		});
		mocks.env.EDGE_CONFIG = EDGE;
		const fetch = vi.fn(async (url: string) => {
			expect(url).toBe(
				"https://edge-config.vercel.com/ecfg_abc123/item/meetingsAi?token=tok-1",
			);
			return Response.json({ notesEnabled: false, trialMeetings: 2 });
		});
		vi.stubGlobal("fetch", fetch);
		const value = await config.getMeetingsAiConfig();
		expect(value.notesEnabled).toBe(false);
		expect(value.trialMeetings).toBe(2);
		expect(value.askModels).toEqual(["openai/gpt-6-luna-fast"]);
	});

	it("rereads Edge Config after 30 seconds, not before", async () => {
		mocks.env.EDGE_CONFIG = EDGE;
		const fetch = vi.fn(async () => Response.json({ askEnabled: false }));
		vi.stubGlobal("fetch", fetch);
		await config.getMeetingsAiConfig(1_000);
		await config.getMeetingsAiConfig(20_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await config.getMeetingsAiConfig(31_001);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps the last good Edge Config when it cannot be reached", async () => {
		mocks.env.EDGE_CONFIG = EDGE;
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ askEnabled: false }))
				.mockRejectedValueOnce(new Error("offline")),
		);
		expect((await config.getMeetingsAiConfig(0)).askEnabled).toBe(false);
		expect((await config.getMeetingsAiConfig(40_000)).askEnabled).toBe(false);
	});

	it("never makes a warm request wait for Edge Config", async () => {
		mocks.env.EDGE_CONFIG = EDGE;
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ askEnabled: false }))
				.mockImplementationOnce(() => new Promise(() => {})),
		);
		expect((await config.getMeetingsAiConfig(0)).askEnabled).toBe(false);
		const started = performance.now();
		const stale = await config.getMeetingsAiConfig(60_000);
		expect(performance.now() - started).toBeLessThan(50);
		expect(stale.askEnabled).toBe(false);
	});

	it("falls back to the defaults when a cold read is slow", async () => {
		mocks.env.EDGE_CONFIG = EDGE;
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ trialMeetings: 5 });
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		const started = performance.now();
		const value = await config.getMeetingsAiConfig(0);
		const waited = performance.now() - started;
		expect(waited).toBeGreaterThanOrEqual(450);
		expect(waited).toBeLessThan(1_000);
		expect(value.trialMeetings).toBe(5);
		expect(value.notesEnabled).toBe(true);
	});

	it("runs one refresh at a time", async () => {
		mocks.env.EDGE_CONFIG = EDGE;
		const fetch = vi.fn(async () => Response.json({ askEnabled: false }));
		vi.stubGlobal("fetch", fetch);
		await config.getMeetingsAiConfig(0);
		await Promise.all([
			config.getMeetingsAiConfig(40_000),
			config.getMeetingsAiConfig(40_001),
			config.getMeetingsAiConfig(40_002),
		]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("ignores invalid values", async () => {
		mocks.env.MEETINGS_AI_CONFIG = JSON.stringify({ notesMaxOutputTokens: 5 });
		expect((await config.getMeetingsAiConfig()).notesMaxOutputTokens).toBe(
			16_000,
		);
		mocks.env.MEETINGS_AI_CONFIG = "{not json";
		config.resetMeetingsAiConfigCache();
		expect((await config.getMeetingsAiConfig()).notesEnabled).toBe(true);
	});
});

describe("meetingModelChain", () => {
	it("goes through the gateway when a key or Vercel is present", () => {
		mocks.env.AI_GATEWAY_API_KEY = "key";
		const chain = config.meetingModelChain(
			{ ...config.MEETINGS_AI_DEFAULTS, notesModels: ["a/b", "c/d"] },
			"notes",
		);
		expect(chain.map((s) => s.label)).toEqual(["gateway:a/b", "gateway:c/d"]);
		expect(chain[0]?.model()).toBe("gateway:a/b");
		expect(chain[0]?.maxOutputTokens).toBe(16_000);
	});

	it("is empty without the gateway or a provider key", () => {
		expect(
			config.meetingModelChain(config.MEETINGS_AI_DEFAULTS, "ask"),
		).toEqual([]);
		expect(config.meetingsAiConfigured("ask")).toBe(false);
	});
});
