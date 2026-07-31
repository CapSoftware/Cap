import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Slack install route contract", () => {
	it("redirects unauthenticated users through the canonical login page", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/integrations/slack/install/route.ts"),
			"utf8",
		);

		expect(route).toContain('new URL("/login", serverEnv().WEB_URL)');
		expect(route).not.toContain('new URL("/auth/signin"');
	});
});
