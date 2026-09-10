import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";

vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("Database should not be reached on self-hosted routes");
	},
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
	serverEnv: () => ({
		WEB_URL: "https://cap.example.com",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

const request = (path: string) =>
	proxy(new NextRequest(`https://cap.example.com${path}`));

describe("self-hosted proxy routes", () => {
	it("allows browser-based CLI authorization pages", () => {
		const source = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
		expect(source).toContain('path.startsWith("/cli/")');
	});

	it.each([
		"/logos/browsers/google-chrome.svg",
		"/illustrations/mask-bg.webp",
		"/sounds/recording-start.mp3",
		"/rive/main.riv",
		"/fonts/Inter.woff2",
	])("serves the public asset %s instead of redirecting", async (path) => {
		const response = await request(path);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
	});

	it("still redirects unauthenticated page routes to /login", async () => {
		const response = await request("/pricing");

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://cap.example.com/login",
		);
	});

	it("does not treat a share link as a static asset", async () => {
		const response = await request("/s/video123");

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
	});
});
