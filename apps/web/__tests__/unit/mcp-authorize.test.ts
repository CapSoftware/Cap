import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	createCode: vi.fn(),
	isRateLimited: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user-1", email: "owner@example.com" }),
}));
vi.mock("next/navigation", () => ({
	redirect: (url: string) => {
		throw new Error(`REDIRECT:${url}`);
	},
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: mocks.isRateLimited,
	RATE_LIMIT_IDS: { AGENT_AUTHORIZATION: "rl_agent_authorization" },
}));
vi.mock("@/lib/mcp-auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/mcp-auth")>()),
	validateMcpAuthorizationRequest: mocks.validate,
	createMcpAuthorizationCode: mocks.createCode,
	mcpIssuer: () => "https://cap.so",
}));

const { authorizeMcpClient } = await import("@/app/mcp/authorize/actions");
const { default: McpAuthorizePage } = await import("@/app/mcp/authorize/page");

const oauthParams = {
	client_id: "cap_mcp_client_test",
	redirect_uri: "https://agent.example/callback",
	response_type: "code",
	state: "state-value",
	code_challenge: "c".repeat(43),
	code_challenge_method: "S256",
	scope: "caps:read",
	resource: "https://cap.so/api/mcp",
};

const submit = async (decisions: string[]) => {
	const form = new FormData();
	for (const [key, value] of Object.entries(oauthParams))
		form.append(key, value);
	for (const decision of decisions) form.append("decision", decision);
	const outcome = await authorizeMcpClient(form).catch((error: Error) => error);
	expect(outcome).toBeInstanceOf(Error);
	const message = (outcome as Error).message;
	expect(message.startsWith("REDIRECT:")).toBe(true);
	return new URL(message.slice("REDIRECT:".length));
};

beforeEach(() => {
	mocks.validate.mockReset();
	mocks.validate.mockResolvedValue({
		clientId: oauthParams.client_id,
		redirectUri: oauthParams.redirect_uri,
		codeChallenge: oauthParams.code_challenge,
		state: oauthParams.state,
		resource: oauthParams.resource,
		clientName: "Test Agent",
	});
	mocks.createCode.mockReset();
	mocks.createCode.mockResolvedValue("cap_mcp_code_test");
	mocks.isRateLimited.mockReset();
	mocks.isRateLimited.mockResolvedValue(false);
});

describe("MCP authorize page", () => {
	it("only carries OAuth request parameters into the form", async () => {
		const element = await McpAuthorizePage({
			searchParams: Promise.resolve({
				...oauthParams,
				decision: "approve",
				extra: "value",
			}),
		});
		const html = renderToStaticMarkup(element);
		const hiddenNames = [
			...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g),
		].map((match) => /name="([^"]*)"/.exec(match[0])?.[1]);

		expect(hiddenNames).toEqual(
			expect.arrayContaining(Object.keys(oauthParams)),
		);
		expect(hiddenNames).not.toContain("decision");
		expect(hiddenNames).not.toContain("extra");
		const validated = mocks.validate.mock.calls[0]?.[0] as URLSearchParams;
		expect([...validated.keys()].sort()).toEqual(
			Object.keys(oauthParams).sort(),
		);
	});
});

describe("authorizeMcpClient", () => {
	it("issues a code for a single approve decision", async () => {
		const callback = await submit(["approve"]);

		expect(mocks.createCode).toHaveBeenCalledTimes(1);
		expect(callback.searchParams.get("code")).toBe("cap_mcp_code_test");
		expect(callback.searchParams.get("error")).toBeNull();
		expect(callback.searchParams.get("state")).toBe("state-value");
	});

	it.each([
		[["deny"]],
		[["approve", "deny"]],
		[["deny", "approve"]],
		[["approve", "approve"]],
		[[]],
	])("returns access_denied for decisions %j", async (decisions) => {
		const callback = await submit(decisions);

		expect(mocks.createCode).not.toHaveBeenCalled();
		expect(callback.searchParams.get("code")).toBeNull();
		expect(callback.searchParams.get("error")).toBe("access_denied");
		expect(callback.searchParams.get("state")).toBe("state-value");
	});
});
