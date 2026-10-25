import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => [] }) }),
	}),
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

const send = (url: string, headers: Record<string, string> = {}) =>
	proxy(new NextRequest(url, { headers }));

const frameAncestors = (response: Response) =>
	[...response.headers.values()].filter((value) =>
		value.startsWith("frame-ancestors"),
	);

const expectFrameHeaders = (response: Response) => {
	expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
	expect(frameAncestors(response)).toEqual(["frame-ancestors https://cap.so"]);
};

const expectNoFrameHeaders = (response: Response) => {
	expect(response.headers.get("x-frame-options")).toBeNull();
	expect(frameAncestors(response)).toEqual([]);
};

describe("proxy frame headers", () => {
	it.each([
		"/login",
		"/dashboard",
		"/dashboard/caps",
		"/dashboard/settings/account",
		"/dashboard/settings/organization/billing",
		"/onboarding",
		"/onboarding/organization-setup",
		"/invite/invite-id",
		"/cli/authorize",
		"/mcp/authorize",
		"/admin",
		"/admin/replace-video",
		"/admin/reprocess-video",
		"/signup",
		"/verify-otp",
	])("sets frame headers on %s", async (path) => {
		const response = await send(`https://cap.so${path}`);
		expect(response.status).toBe(200);
		expectFrameHeaders(response);
	});

	it.each([
		"/",
		"/s/video-id",
		"/embed/video-id",
		"/c/collection-id",
		"/pricing",
		"/blog/some-post",
		"/cli/complete",
		"/dashboards",
		"/invited",
		"/administrator",
		"/signups",
		"/verify-otp-help",
	])("leaves %s without frame headers", async (path) => {
		const response = await send(`https://cap.so${path}`);
		expectNoFrameHeaders(response);
	});

	it("leaves the share iframe redirect without frame headers", async () => {
		const response = await send("https://cap.so/s/video-id", {
			"sec-fetch-dest": "iframe",
		});
		expect(response.headers.get("location")).toBe(
			"https://cap.so/embed/video-id",
		);
		expectNoFrameHeaders(response);
	});

	it("keeps redirecting app pages on custom domains to the main origin", async () => {
		const response = await send("https://videos.customer.example/dashboard");
		expect(response.headers.get("location")).toBe("https://cap.so/dashboard");
		expectFrameHeaders(response);
	});

	it("keeps serving share pages on verified custom domains without frame headers", async () => {
		const response = await send("https://videos.customer.example/s/video-id", {
			cookie: "verified_domain=videos.customer.example",
		});
		expect(response.status).toBe(200);
		expectNoFrameHeaders(response);
	});
});
