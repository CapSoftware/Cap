import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";

const mocks = vi.hoisted(() => ({ isCap: "true" as string | undefined }));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => [] }) }),
	}),
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

const send = (
	url: string,
	init: { headers?: HeadersInit; method?: string } = {},
) => proxy(new NextRequest(url, init));

const clickCookie = (response: Response) =>
	response.headers
		.getSetCookie()
		.find((cookie) => cookie.startsWith("dub_id="));

describe("proxy referral click capture", () => {
	beforeEach(() => {
		mocks.isCap = "true";
	});

	it("stores the partner click from a go.cap.so landing", async () => {
		const response = await send("https://cap.so/?dub_id=k3XpQ9wLm2Vb7RtA");
		const cookie = clickCookie(response);
		expect(cookie).toBeDefined();
		expect(cookie).toContain("dub_id=k3XpQ9wLm2Vb7RtA");
		expect(cookie).toContain("Domain=.cap.so");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=7776000");
		expect(cookie?.toLowerCase()).toContain("samesite=lax");
		expect(cookie).toContain("Secure");
		expect(cookie).not.toContain("HttpOnly");
	});

	it.each(["/pricing", "/download", "/login", "/signup"])(
		"stores the click on %s",
		async (path) => {
			const response = await send(`https://cap.so${path}?dub_id=click_1`);
			expect(clickCookie(response)).toContain("dub_id=click_1");
		},
	);

	it("keeps the click when a signed-in visitor is redirected to the dashboard", async () => {
		const response = await send("https://cap.so/?dub_id=click_1", {
			headers: { cookie: "next-auth.session-token=abc" },
		});
		expect(response.status).toBe(307);
		expect(clickCookie(response)).toContain("dub_id=click_1");
	});

	it("overwrites an older click (last-click attribution)", async () => {
		const response = await send("https://cap.so/?dub_id=click_new", {
			headers: { cookie: "dub_id=click_old" },
		});
		expect(clickCookie(response)).toContain("dub_id=click_new");
	});

	it.each([
		"https://cap.so/",
		"https://cap.so/?dub_id=",
		"https://cap.so/?dub_id=bad%20value",
		"https://cap.so/?dub_id=x%3Bdomain%3Devil.com",
	])("leaves cookies alone for %s", async (url) => {
		const response = await send(url);
		expect(clickCookie(response)).toBeUndefined();
	});

	it.each([
		"/dev/playback-id-0123456789ab",
		"/dev/playback-id-0123456789ab/embed",
	])("sets no cookie at all on the developer video page %s", async (path) => {
		const response = await send(`https://cap.so${path}?dub_id=click_1`);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("ignores non-GET requests", async () => {
		const response = await send("https://cap.so/?dub_id=click_1", {
			method: "POST",
		});
		expect(clickCookie(response)).toBeUndefined();
	});

	it("does nothing on self-hosted deployments", async () => {
		mocks.isCap = undefined;
		const response = await send("https://cap.so/login?dub_id=click_1");
		expect(clickCookie(response)).toBeUndefined();
	});
});

describe("proxy Dub forwarding", () => {
	beforeEach(() => {
		mocks.isCap = "true";
	});

	const overriddenHeaders = (response: Response) =>
		(response.headers.get("x-middleware-override-headers") ?? "").split(",");

	it.each([
		["/_proxy/dub/script.js", "https://www.dubcdn.com/analytics/script.js"],
		["/_proxy/dub/track/click", "https://api.dub.co/track/click"],
	])("forwards %s to Dub", async (path, target) => {
		const response = await send(`https://cap.so${path}`, {
			method: path.endsWith("click") ? "POST" : "GET",
		});
		expect(response.headers.get("x-middleware-rewrite")).toBe(target);
	});

	it("does not forward the visitor's cookies to Dub", async () => {
		const response = await send("https://cap.so/_proxy/dub/track/click", {
			method: "POST",
			headers: {
				cookie: "next-auth.session-token=secret; dub_id=click_1",
				"content-type": "application/json",
			},
		});
		expect(response.headers.get("x-middleware-rewrite")).toBe(
			"https://api.dub.co/track/click",
		);
		const forwarded = overriddenHeaders(response);
		expect(forwarded).toContain("content-type");
		expect(forwarded).not.toContain("cookie");
		expect(response.headers.get("x-middleware-request-cookie")).toBeNull();
	});

	it.each([
		"/_proxy/dub/",
		"/_proxy/dub/track/",
		"/_proxy/dub/track/click/extra",
		"/_proxy/dub/links",
		"/_proxy/dub/track/..%2Fcustomers",
	])("rejects %s", async (path) => {
		const response = await send(`https://cap.so${path}`);
		expect(response.status).toBe(404);
		expect(response.headers.get("x-middleware-rewrite")).toBeNull();
	});

	it("is off on self-hosted deployments", async () => {
		mocks.isCap = undefined;
		const response = await send("https://cap.so/_proxy/dub/script.js");
		expect(response.status).toBe(404);
		expect(response.headers.get("x-middleware-rewrite")).toBeNull();
	});
});
