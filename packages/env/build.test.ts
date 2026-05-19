import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env = { ...originalEnv };
	vi.resetModules();
});

afterEach(() => {
	process.env = { ...originalEnv };
});

describe("buildEnv", () => {
	it("uses WEB_URL as the public web URL when present", async () => {
		process.env.WEB_URL = "https://web-url.example";
		process.env.NEXT_PUBLIC_WEB_URL = "https://next-public.example";

		const { buildEnv } = await import("./build");

		expect(buildEnv.NEXT_PUBLIC_WEB_URL).toBe("https://web-url.example");
	});

	it("falls back to NEXT_PUBLIC_WEB_URL when WEB_URL is absent", async () => {
		delete process.env.WEB_URL;
		process.env.NEXT_PUBLIC_WEB_URL = "https://next-public.example";

		const { buildEnv } = await import("./build");

		expect(buildEnv.NEXT_PUBLIC_WEB_URL).toBe("https://next-public.example");
	});
});
