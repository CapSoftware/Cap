import { createHash } from "node:crypto";
import { User } from "@cap/web-domain";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const databaseState = vi.hoisted(() => ({
	selected: null as Record<string, unknown> | null,
	inserted: [] as Record<string, unknown>[],
	updated: 0,
	quotaCount: 0,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		insert: () => ({
			values: async (row: Record<string, unknown>) => {
				databaseState.inserted.push(row);
			},
		}),
		transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				select: () => ({
					from: () => ({
						where: () => ({
							limit: () =>
								Object.assign(Promise.resolve([databaseState.selected]), {
									for: async () => [
										{ registrations: databaseState.quotaCount },
									],
								}),
						}),
					}),
				}),
				update: () => ({
					set: () => ({
						where: async () => {
							databaseState.updated += 1;
							return [{ affectedRows: 1 }];
						},
					}),
				}),
				insert: () => ({
					values: (row: Record<string, unknown>) => {
						if ("clientId" in row || "codeHash" in row || "accessHash" in row)
							databaseState.inserted.push(row);
						return { onDuplicateKeyUpdate: async () => undefined };
					},
				}),
			}),
	}),
}));

import {
	createMcpAuthorizationCode,
	exchangeMcpCode,
	isMcpRedirectUri,
	parseMcpAuthorizationRequest,
	refreshMcpTokens,
} from "@/lib/mcp-auth";

const resource = "https://cap.so/api/mcp";
const challenge = createHash("sha256")
	.update("v".repeat(43))
	.digest("base64url");

const validRequest = () =>
	new URLSearchParams({
		client_id: "cap_mcp_client_test",
		redirect_uri: "https://chatgpt.com/connector/callback",
		response_type: "code",
		state: "state-value",
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "caps:read",
		resource,
	});

describe("MCP OAuth authorization", () => {
	beforeAll(() => {
		Object.assign(process.env, {
			WEB_URL: "https://cap.so",
			NEXTAUTH_URL: "https://cap.so",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
		});
	});

	beforeEach(() => {
		databaseState.selected = null;
		databaseState.inserted = [];
		databaseState.updated = 0;
		databaseState.quotaCount = 0;
	});
	it("accepts only secure or explicit loopback redirect URIs", () => {
		expect(isMcpRedirectUri("https://chatgpt.com/connector/callback")).toBe(
			true,
		);
		expect(isMcpRedirectUri("http://127.0.0.1:49152/callback")).toBe(true);
		for (const uri of [
			"http://chatgpt.com/connector/callback",
			"http://localhost:49152/callback",
			"http://127.0.0.1/callback",
			"https://chatgpt.com/connector/callback#fragment",
			"https://user:password@chatgpt.com/callback",
			"javascript:alert(1)",
		])
			expect(isMcpRedirectUri(uri)).toBe(false);
	});

	it("binds authorization to PKCE S256, read scope, and the exact resource", () => {
		expect(
			parseMcpAuthorizationRequest(validRequest(), resource),
		).toMatchObject({
			clientId: "cap_mcp_client_test",
			resource,
			codeChallenge: challenge,
		});
		for (const [key, value] of [
			["code_challenge_method", "plain"],
			["scope", "caps:read caps:write"],
			["resource", "https://cap.so/api/v1"],
			["redirect_uri", "https://attacker.example/callback#fragment"],
		] as const) {
			const params = validRequest();
			params.set(key, value);
			expect(parseMcpAuthorizationRequest(params, resource)).toBeNull();
		}
	});

	it("activates a registered client when consent issues a code", async () => {
		const request = parseMcpAuthorizationRequest(validRequest(), resource);
		expect(request).not.toBeNull();
		if (!request) return;
		const code = await createMcpAuthorizationCode(
			User.UserId.make("owner"),
			request,
		);
		expect(code).toMatch(/^cap_mcp_code_[A-Za-z0-9_-]{43}$/);
		expect(databaseState.updated).toBe(1);
		expect(databaseState.inserted[0]).toMatchObject({
			userId: "owner",
			clientId: request.clientId,
			resource,
		});
	});

	it("exchanges a single PKCE-bound code for a resource-bound token", async () => {
		const code = `cap_mcp_code_${"c".repeat(43)}`;
		databaseState.selected = {
			id: "grant",
			userId: "owner",
			clientId: "cap_mcp_client_test",
			redirectUri: "https://chatgpt.com/connector/callback",
			resource,
			codeChallenge: challenge,
			consumedAt: null,
			expiresAt: new Date(Date.now() + 60_000),
		};
		const params = new URLSearchParams({
			code,
			client_id: "cap_mcp_client_test",
			redirect_uri: "https://chatgpt.com/connector/callback",
			code_verifier: "v".repeat(43),
			resource,
		});
		const issued = await exchangeMcpCode(params);
		expect(issued?.access_token).toMatch(/^cap_mcp_[A-Za-z0-9_-]{43}$/);
		expect(issued?.refresh_token).toMatch(
			/^cap_mcp_refresh_[A-Za-z0-9_-]{43}$/,
		);
		expect(databaseState.updated).toBe(1);
		expect(databaseState.inserted[0]).toMatchObject({
			userId: "owner",
			clientId: "cap_mcp_client_test",
			resource,
		});
		params.set("resource", "https://cap.so/api/v1");
		expect(await exchangeMcpCode(params)).toBeNull();
		expect(databaseState.inserted).toHaveLength(1);
	});

	it("revokes a refresh family when a used refresh token is replayed", async () => {
		databaseState.selected = {
			id: "old-token",
			clientId: "cap_mcp_client_test",
			resource,
			familyId: "family",
			revokedAt: new Date(),
			refreshExpiresAt: new Date(Date.now() + 60_000),
		};
		const outcome = await refreshMcpTokens(
			new URLSearchParams({
				refresh_token: `cap_mcp_refresh_${"r".repeat(43)}`,
				client_id: "cap_mcp_client_test",
				resource,
			}),
		);
		expect(outcome).toBeNull();
		expect(databaseState.updated).toBe(1);
		expect(databaseState.inserted).toHaveLength(0);
	});

	it("registers only public clients with exact safe callback URLs", async () => {
		const { POST } = await import("@/app/api/mcp/oauth/register/route");
		const post = (redirectUri: string) =>
			POST(
				new Request("https://cap.so/api/mcp/oauth/register", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						client_name: "Chat host",
						redirect_uris: [redirectUri],
						token_endpoint_auth_method: "none",
					}),
				}),
			);
		expect((await post("http://attacker.example/callback")).status).toBe(400);
		expect(databaseState.inserted).toHaveLength(0);
		const response = await post("https://chatgpt.com/connector/callback");
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			client_name: "Chat host",
			redirect_uris: ["https://chatgpt.com/connector/callback"],
			token_endpoint_auth_method: "none",
		});
		expect(databaseState.inserted).toHaveLength(1);
		const unnamed = await POST(
			new Request("https://cap.so/api/mcp/oauth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					redirect_uris: ["https://claude.ai/oauth/callback"],
				}),
			}),
		);
		expect(unnamed.status).toBe(201);
		expect(await unnamed.json()).toMatchObject({ client_name: "MCP client" });
		databaseState.inserted = [];
		databaseState.quotaCount = 5_000;
		expect((await post("https://chatgpt.com/connector/callback")).status).toBe(
			429,
		);
		expect(databaseState.inserted).toHaveLength(0);
	});

	it("preserves OAuth error and revocation responses", async () => {
		const { POST: token } = await import("@/app/api/mcp/oauth/token/route");
		const { POST: revoke } = await import("@/app/api/mcp/oauth/revoke/route");
		const unsupported = await token(
			new Request("https://cap.so/api/mcp/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "grant_type=client_credentials",
			}),
		);
		expect(unsupported.status).toBe(400);
		expect(await unsupported.json()).toEqual({
			error: "unsupported_grant_type",
		});
		expect(unsupported.headers.get("cache-control")).toBe("no-store");
		const invalid = await revoke(
			new Request("https://cap.so/api/mcp/oauth/revoke", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: "client_id=client",
			}),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid_request" });
	});
});
