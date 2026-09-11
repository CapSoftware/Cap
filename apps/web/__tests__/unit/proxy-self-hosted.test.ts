import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("self-hosted proxy routes", () => {
	it("does not send public assets through the self-hosted login redirect", () => {
		const source = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
		expect(source).toContain("svg");
		expect(source).toContain("woff2?");
	});

	it("allows browser-based CLI authorization pages", () => {
		const source = readFileSync(join(process.cwd(), "proxy.ts"), "utf8");
		expect(source).toContain('path.startsWith("/cli/")');
	});
});
