import { createHmac } from "node:crypto";
import {
	createSsoLoginIntent,
	ssoIntentCookie,
	ssoLoginErrorPath,
	verifySsoLoginIntent,
} from "@cap/database/auth/sso-state";
import { describe, expect, it } from "vitest";

const secret = "test-sso-intent-secret-with-sufficient-entropy";
const now = Date.UTC(2026, 8, 2, 12);
const context = {
	organizationId: "caporganization",
	workosOrganizationId: "org_verified",
	connectionId: "conn_verified",
	actorId: "signedinuser123",
};

function signedPayload(payload: unknown) {
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

describe("SSO login intent", () => {
	it("binds the tenant, connection, and existing account with a fresh nonce", () => {
		const first = createSsoLoginIntent(context, secret, now);
		const second = createSsoLoginIntent(context, secret, now);
		expect(first).not.toBe(second);
		expect(verifySsoLoginIntent(first, secret, now)).toMatchObject(context);
	});

	it("preserves an anonymous sign-in instead of accepting a later account", () => {
		const value = createSsoLoginIntent(
			{ ...context, actorId: null },
			secret,
			now,
		);
		expect(verifySsoLoginIntent(value, secret, now)?.actorId).toBeNull();
	});

	it("rejects a substituted organization even when the rest of the cookie matches", () => {
		const value = createSsoLoginIntent(context, secret, now);
		const [encoded, signature] = value.split(".");
		const payload = JSON.parse(
			Buffer.from(encoded ?? "", "base64url").toString(),
		);
		payload.workosOrganizationId = "org_attacker";
		const substituted = Buffer.from(JSON.stringify(payload)).toString(
			"base64url",
		);
		expect(
			verifySsoLoginIntent(`${substituted}.${signature}`, secret, now),
		).toBeNull();
	});

	it("rejects a wrong signing key and malformed signature without throwing", () => {
		const value = createSsoLoginIntent(context, secret, now);
		expect(verifySsoLoginIntent(value, "other-secret", now)).toBeNull();
		expect(verifySsoLoginIntent(`${value}extra`, secret, now)).toBeNull();
		expect(verifySsoLoginIntent(`${value}.extra`, secret, now)).toBeNull();
	});

	it("expires at ten minutes and permits only a small future clock skew", () => {
		const value = createSsoLoginIntent(context, secret, now);
		expect(verifySsoLoginIntent(value, secret, now + 599_000)).not.toBeNull();
		expect(verifySsoLoginIntent(value, secret, now + 600_000)).toBeNull();
		expect(verifySsoLoginIntent(value, secret, now - 31_000)).toBeNull();
	});

	it.each(["SsoSignInFailed", "SsoMissingProfileAttributes"] as const)(
		"preserves a same-origin app continuation through %s recovery",
		(error) => {
			const returnTo =
				"/api/mobile/session/request?redirectUri=cap%3A%2F%2Fauth";
			const value = createSsoLoginIntent({ ...context, returnTo }, secret, now);
			expect(verifySsoLoginIntent(value, secret, now)?.returnTo).toBe(returnTo);
			const errorUrl = new URL(
				ssoLoginErrorPath(error, returnTo),
				"https://cap.test",
			);
			expect(errorUrl.searchParams.get("next")).toBe(returnTo);
			expect(errorUrl.searchParams.get("error")).toBe(error);
		},
	);

	it.each([
		"https://attacker.example/",
		"//attacker.example/",
		"/\\attacker.example/",
		"/.//attacker.example/",
		"/\n/attacker.example/",
		`/${"a".repeat(1024)}`,
	])("discards unsafe or oversized return paths: %j", (returnTo) => {
		const value = createSsoLoginIntent({ ...context, returnTo }, secret, now);
		expect(verifySsoLoginIntent(value, secret, now)?.returnTo).toBe(
			"/dashboard",
		);
		expect(ssoLoginErrorPath("SsoSessionExpired", returnTo)).toBe(
			"/login?error=SsoSessionExpired",
		);
	});

	it.each([
		{ version: 2 },
		{ organizationId: "" },
		{ workosOrganizationId: "attacker" },
		{ connectionId: "https://attacker.example" },
		{ actorId: undefined },
		{ actorId: 42 },
		{ issuedAt: "now" },
		{ nonce: "" },
		{ returnTo: "//attacker.example" },
	])("rejects authenticated malformed claims: %j", (override) => {
		const payload = {
			...context,
			version: 1,
			issuedAt: Math.floor(now / 1000),
			nonce: "a".repeat(32),
			...override,
		};
		expect(
			verifySsoLoginIntent(signedPayload(payload), secret, now),
		).toBeNull();
	});

	it("rejects missing and oversized cookies", () => {
		expect(verifySsoLoginIntent(undefined, secret, now)).toBeNull();
		expect(verifySsoLoginIntent("a".repeat(2049), secret, now)).toBeNull();
		expect(verifySsoLoginIntent(signedPayload(null), secret, now)).toBeNull();
	});

	it("uses a host-only secure HttpOnly cookie on HTTPS", () => {
		const cookie = ssoIntentCookie(true);
		expect(cookie.name).toMatch(/^__Host-/);
		expect(cookie.options).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
			maxAge: 600,
		});
		expect(ssoIntentCookie(false).name).not.toMatch(/^__Host-/);
	});
});
