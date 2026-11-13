import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";

vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("Database should not be reached for console pages");
	},
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		WEB_URL: "https://cap.example.com",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));

vi.mock("@/lib/agent-markdown", () => ({
	agentMarkdownResponse: async () => null,
}));

const FORWARDED = "x-middleware-request-x-cap-infra-path";

const forwarded = async (
	path: string,
	headers: Record<string, string> = {},
) => {
	const response = await proxy(
		new NextRequest(`https://cap.example.com${path}`, { headers }),
	);
	expect(response.status).toBe(200);
	return response.headers.get(FORWARDED);
};

describe("the address the Infra console is told it renders for", () => {
	it.each([
		"/dashboard/infra/a1/billing",
		"/dashboard/infra/a1/videos/v_123",
		"/dashboard/infra/a1/videos?userId=u_42",
		"/dashboard/infra",
	])("is %s", async (path) => {
		expect(await forwarded(path)).toBe(path);
	});

	it("replaces a value sent by the client", async () => {
		expect(
			await forwarded("/dashboard/infra/a1/keys", {
				"x-cap-infra-path": "https://evil.example/",
			}),
		).toBe("/dashboard/infra/a1/keys");
	});

	it.each(["/dashboard/caps", "/pricing", "/dashboard/infrastructure"])(
		"is not sent for %s",
		async (path) => {
			expect(await forwarded(path)).toBeNull();
		},
	);
});
