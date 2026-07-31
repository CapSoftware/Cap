import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { getShareIframeRedirectUrl } from "@/lib/share-iframe-navigation";
import { proxy } from "../../proxy";

vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("Database should not be reached for iframe redirects");
	},
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret",
		WEB_URL: "https://cap.so",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

describe("share iframe navigation", () => {
	it("redirects a framed share navigation to the player", () => {
		const redirectUrl = getShareIframeRedirectUrl({
			method: "GET",
			requestUrl: "https://cap.so/s/video123?autoplay=true",
			fetchDestination: "iframe",
		});

		expect(redirectUrl?.toString()).toBe(
			"https://cap.so/embed/video123?autoplay=true",
		);
	});

	it("preserves custom origins for the existing proxy routing", () => {
		const redirectUrl = getShareIframeRedirectUrl({
			method: "GET",
			requestUrl: "https://recordings.example.com/s/video123",
			fetchDestination: "iframe",
		});

		expect(redirectUrl?.toString()).toBe(
			"https://recordings.example.com/embed/video123",
		);
	});

	it("returns the player redirect from the web proxy", async () => {
		const response = await proxy(
			new NextRequest("https://cap.so/s/video123?autoplay=true", {
				headers: { "sec-fetch-dest": "iframe" },
			}),
		);

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://cap.so/embed/video123?autoplay=true",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("vary")).toBe("Sec-Fetch-Dest");
		expect(response.headers.get("set-cookie")).toContain(
			"cap_analytics_browser_token=",
		);
	});

	it("keeps normal share navigations on the share page", async () => {
		const response = await proxy(
			new NextRequest("https://cap.so/s/video123", {
				headers: { "sec-fetch-dest": "document" },
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it.each([
		{
			method: "GET",
			requestUrl: "https://cap.so/s/video123",
			fetchDestination: "document",
		},
		{
			method: "GET",
			requestUrl: "https://cap.so/s/video123",
			fetchDestination: null,
		},
		{
			method: "POST",
			requestUrl: "https://cap.so/s/video123",
			fetchDestination: "iframe",
		},
		{
			method: "GET",
			requestUrl: "https://cap.so/s/video123/edit",
			fetchDestination: "iframe",
		},
		{
			method: "GET",
			requestUrl: "https://cap.so/s/",
			fetchDestination: "iframe",
		},
	])("does not redirect $requestUrl for $method/$fetchDestination", (input) => {
		expect(getShareIframeRedirectUrl(input)).toBeNull();
	});
});
