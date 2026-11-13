import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearEmbedOriginsCache,
	EMBED_ORIGINS_CACHE_MS,
} from "@/lib/developer-embed-origins";
import { proxy } from "../../proxy";

const state = vi.hoisted(() => ({
	domains: [] as string[],
	fail: false,
	lookups: 0,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [],
				innerJoin: () => ({
					where: async () => {
						state.lookups += 1;
						if (state.fail) throw new Error("database unavailable");
						return state.domains.map((domain) => ({ domain }));
					},
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	organizations: {},
	developerAppDomains: {},
	developerVideos: {},
}));

vi.mock("drizzle-orm", () => ({ eq: () => undefined }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

const PLAYBACK_ID = "playback-id-0123456789ab";
const EMBED = `https://cap.so/dev/${PLAYBACK_ID}/embed`;

const send = (url: string, headers: Record<string, string> = {}) =>
	proxy(new NextRequest(url, { headers }));

const headerList = (response: Response) => [...response.headers.entries()];

beforeEach(() => {
	state.domains = [];
	state.fail = false;
	state.lookups = 0;
	clearEmbedOriginsCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("embed frame-ancestors", () => {
	it("leaves the embed response untouched when the list is empty", async () => {
		const embed = await send(`${EMBED}?autoplay=1`);
		const hosted = await send(`https://cap.so/dev/${PLAYBACK_ID}`);
		expect(state.lookups).toBe(1);
		expect(embed.status).toBe(200);
		expect(headerList(embed)).toEqual(headerList(hosted));
		expect(headerList(embed)).toEqual([["x-middleware-next", "1"]]);
	});

	it("allows one site", async () => {
		state.domains = ["https://myshop.com"];
		const response = await send(EMBED);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'self' https://myshop.com",
		);
		expect(response.headers.get("x-frame-options")).toBeNull();
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("allows several sites and skips stored entries it cannot honour", async () => {
		state.domains = [
			"https://myshop.com",
			"*.myshop.com",
			"http://myshop.com",
			"https://docs.myshop.com",
		];
		const response = await send(EMBED);
		expect(response.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'self' https://myshop.com https://docs.myshop.com",
		);
	});

	it("sends one policy header for the RSC request too", async () => {
		state.domains = ["https://myshop.com"];
		const response = await send(EMBED, { rsc: "1" });
		const policies = [...response.headers.entries()].filter(
			([name]) => name === "content-security-policy",
		);
		expect(policies).toEqual([
			["content-security-policy", "frame-ancestors 'self' https://myshop.com"],
		]);
	});

	it("serves the embed as before when the list cannot be read", async () => {
		state.domains = ["https://myshop.com"];
		state.fail = true;
		const response = await send(EMBED);
		expect(response.status).toBe(200);
		expect(headerList(response)).toEqual([["x-middleware-next", "1"]]);
	});

	it("reads an app's list once a minute per instance", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		state.domains = ["https://myshop.com"];
		await send(EMBED);
		state.domains = [];
		const cached = await send(EMBED);
		expect(state.lookups).toBe(1);
		expect(cached.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'self' https://myshop.com",
		);

		vi.setSystemTime(Date.now() + EMBED_ORIGINS_CACHE_MS + 1);
		const fresh = await send(EMBED);
		expect(state.lookups).toBe(2);
		expect(fresh.headers.get("content-security-policy")).toBeNull();
	});

	it("does not keep a failed read", async () => {
		state.domains = ["https://myshop.com"];
		state.fail = true;
		await send(EMBED);
		state.fail = false;
		const response = await send(EMBED);
		expect(state.lookups).toBe(2);
		expect(response.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'self' https://myshop.com",
		);
	});

	it.each([
		`/dev/${PLAYBACK_ID}`,
		`/dev/${PLAYBACK_ID}/embed/extra`,
		"/dev/short/embed",
		`/s/${PLAYBACK_ID}`,
		`/embed/${PLAYBACK_ID}`,
		"/",
		"/pricing",
	])("never restricts framing of %s", async (path) => {
		state.domains = ["https://myshop.com"];
		const response = await send(`https://cap.so${path}`);
		expect(state.lookups).toBe(0);
		expect(response.headers.get("content-security-policy")).toBeNull();
	});
});
