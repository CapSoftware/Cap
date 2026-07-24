import { createHash } from "node:crypto";
import {
	isLegacyAgentKeySource,
	shouldRefreshAgentLastUsedAt,
} from "@cap/web-backend";
import { describe, expect, it } from "vitest";
import {
	buildAgentCallbackUrl,
	createAgentAccessToken,
	hashAgentSecret,
	isAgentCodeVerifier,
	isAgentLoopbackRedirectUri,
	parseAgentAuthorizationRequest,
	parseAgentScopes,
	verifyAgentCodeChallenge,
} from "@/lib/agent-auth";

const state = "s".repeat(43);
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("agent browser authorization", () => {
	it("only accepts explicit loopback callback URLs", () => {
		expect(isAgentLoopbackRedirectUri("http://127.0.0.1:49152/callback")).toBe(
			true,
		);
		expect(isAgentLoopbackRedirectUri("http://[::1]:49152/callback")).toBe(
			true,
		);
		for (const value of [
			"https://127.0.0.1:49152/callback",
			"http://localhost:49152/callback",
			"http://127.0.0.1/callback",
			"http://127.0.0.1:49152/other",
			"http://127.0.0.1:49152/callback?next=https://example.com",
			"http://example.com:49152/callback",
		]) {
			expect(isAgentLoopbackRedirectUri(value)).toBe(false);
		}
	});

	it("requires PKCE S256, state, and known scopes", () => {
		const request = parseAgentAuthorizationRequest({
			client_id: "cap-cli",
			redirect_uri: "http://127.0.0.1:49152/callback",
			response_type: "code",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
			scope: "caps:read caps:comment",
		});
		expect(request).toMatchObject({
			clientId: "cap-cli",
			scopes: ["caps:read", "caps:comment"],
		});
		expect(
			parseAgentAuthorizationRequest({
				client_id: "cap-cli",
				redirect_uri: "http://127.0.0.1:49152/callback",
				response_type: "code",
				state,
				code_challenge: challenge,
				code_challenge_method: "plain",
				scope: "caps:read",
			}),
		).toBeNull();
		expect(parseAgentScopes("caps:comment")).toBeNull();
		expect(parseAgentScopes("caps:read unknown")).toBeNull();
		expect(
			parseAgentScopes(
				"caps:read caps:upload library:write organizations:manage developer:secrets",
			),
		).toEqual([
			"caps:read",
			"caps:upload",
			"library:write",
			"organizations:manage",
			"developer:secrets",
		]);
	});

	it("verifies the RFC 7636 challenge", () => {
		expect(isAgentCodeVerifier(verifier)).toBe(true);
		expect(verifyAgentCodeChallenge(verifier, challenge)).toBe(true);
		expect(verifyAgentCodeChallenge("x".repeat(43), challenge)).toBe(false);
	});

	it("builds a callback without accepting an open redirect", () => {
		const callback = buildAgentCallbackUrl("http://127.0.0.1:49152/callback", {
			state,
			code: "one-time-code",
		});
		expect(callback).toBe(
			`http://127.0.0.1:49152/callback?state=${state}&code=one-time-code`,
		);
		expect(
			buildAgentCallbackUrl("https://example.com/callback", {
				state,
				code: "code",
			}),
		).toBeNull();
	});

	it("hashes credentials and never embeds the raw value", () => {
		const token = createAgentAccessToken();
		expect(token).toMatch(/^cap_cli_[A-Za-z0-9_-]{43}$/);
		expect(hashAgentSecret(token)).toMatch(/^[a-f0-9]{64}$/);
		expect(hashAgentSecret(token)).not.toContain(token);
	});
});
describe("legacy agent credentials", () => {
	it("accepts desktop-era keys without extending mobile or extension keys", () => {
		expect(isLegacyAgentKeySource("desktop")).toBe(true);
		expect(isLegacyAgentKeySource("unknown")).toBe(true);
		expect(isLegacyAgentKeySource("mobile")).toBe(false);
		expect(isLegacyAgentKeySource("extension")).toBe(false);
	});
});

describe("agent credential usage tracking", () => {
	it("refreshes missing and stale usage timestamps", () => {
		const now = new Date("2026-07-19T00:00:00.000Z");
		expect(shouldRefreshAgentLastUsedAt(null, now)).toBe(true);
		expect(
			shouldRefreshAgentLastUsedAt(new Date("2026-07-18T23:55:00.000Z"), now),
		).toBe(true);
		expect(
			shouldRefreshAgentLastUsedAt(new Date("2026-07-18T23:55:00.001Z"), now),
		).toBe(false);
	});
});
