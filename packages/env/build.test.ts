import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

function resetEnv() {
	for (const key of Object.keys(process.env)) {
		delete process.env[key];
	}
	Object.assign(process.env, originalEnv);
}

afterEach(() => {
	resetEnv();
	vi.resetModules();
});

describe("buildEnv", () => {
	it("uses WEB_URL as the public web URL fallback", async () => {
		process.env.WEB_URL = "https://cap.example";
		delete process.env.NEXT_PUBLIC_WEB_URL;

		const { buildEnv } = await import("./build");

		expect(buildEnv.NEXT_PUBLIC_WEB_URL).toBe("https://cap.example");
	});

	it("caches the parsed environment after first access", async () => {
		process.env.WEB_URL = "https://first.example";

		const { buildEnv } = await import("./build");

		expect(buildEnv.NEXT_PUBLIC_WEB_URL).toBe("https://first.example");

		process.env.WEB_URL = "https://second.example";

		expect(buildEnv.NEXT_PUBLIC_WEB_URL).toBe("https://first.example");
	});
});
