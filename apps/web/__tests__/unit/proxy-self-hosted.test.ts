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

const expectServed = async (path: string) => {
	const response = await request(path);
	expect(response.status).toBe(200);
	expect(response.headers.get("location")).toBeNull();
};

const expectLoginRedirect = async (path: string) => {
	const response = await request(path);
	expect(response.status).toBe(307);
	expect(response.headers.get("location")).toBe(
		"https://cap.example.com/login",
	);
};

describe("self-hosted proxy routes", () => {
	it("allows browser-based CLI authorization pages", () => {
		const source = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
		expect(source).toContain('path.startsWith("/cli/")');
	});

	it.each([
		"/logos/browsers/google-chrome.svg",
		"/illustrations/app.webp",
		"/sounds/start-recording.ogg",
		"/rive/main.riv",
		"/fonts/Geist-Regular.woff2",
		"/site.webmanifest",
	])("serves the public asset %s instead of redirecting", (path) =>
		expectServed(path),
	);

	it("still redirects page routes to /login", () =>
		expectLoginRedirect("/pricing"));

	it("still redirects extension-suffixed route handlers to /login", () =>
		expectLoginRedirect("/install-cli.sh"));

	it("does not let a missing file through", () =>
		expectLoginRedirect("/logos/missing.svg"));

	it("does not let a directory through", () => expectLoginRedirect("/logos"));

	it("rejects path traversal out of public/", () =>
		expectLoginRedirect("/logos/..%2F..%2Fproxy.ts"));

	it("does not treat a share link as an asset", () =>
		expectServed("/s/video123"));
});
