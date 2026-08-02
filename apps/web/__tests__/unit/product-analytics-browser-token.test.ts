import { createHmac } from "node:crypto";
import { PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE } from "@cap/analytics";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
	createProductAnalyticsBrowserToken,
	createProductAnalyticsStagingAnonymousId,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS,
	readProductAnalyticsBrowserToken,
	readProductAnalyticsBrowserTokenClaims,
	verifyProductAnalyticsBrowserToken,
} from "@/lib/analytics/browser-token";

const secret = "analytics-browser-token-test-secret";
const now = Date.parse("2026-07-12T12:00:00.000Z");

describe("product analytics browser token", () => {
	it("accepts an untampered token inside its bounded lifetime", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(verifyProductAnalyticsBrowserToken(token, secret, now)).toBe(true);
		expect(readProductAnalyticsBrowserTokenClaims(token, secret, now)).toEqual({
			anonymousId: "anonymous-1",
		});
		expect(
			verifyProductAnalyticsBrowserToken(
				token,
				secret,
				now + PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS * 1000,
			),
		).toBe(true);
	});

	it("rejects expired, future, tampered, and malformed tokens", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(
			verifyProductAnalyticsBrowserToken(
				token,
				secret,
				now + (PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS + 1) * 1000,
			),
		).toBe(false);
		expect(
			verifyProductAnalyticsBrowserToken(
				createProductAnalyticsBrowserToken(secret, "anonymous-1", now + 61_000),
				secret,
				now,
			),
		).toBe(false);
		expect(verifyProductAnalyticsBrowserToken(`${token}x`, secret, now)).toBe(
			false,
		);
		expect(verifyProductAnalyticsBrowserToken("invalid", secret, now)).toBe(
			false,
		);
	});

	it("refuses to create or accept a token containing a personal identifier", () => {
		expect(() =>
			createProductAnalyticsBrowserToken(secret, "alice@example.com", now),
		).toThrow("Analytics anonymous ID is invalid");
		const issuedAt = Math.floor(now / 1_000);
		const payload = `v1.${issuedAt}.alice@example.com`;
		const signature = createHmac("sha256", secret)
			.update(payload)
			.digest("base64url");
		expect(
			readProductAnalyticsBrowserTokenClaims(
				`${payload}.${signature}`,
				secret,
				now,
			),
		).toBeUndefined();
	});

	it("creates a stable valid identity for an exact-SHA staging run", () => {
		const runId =
			"synthetic_run_30712960079_3_53890769e3db23887535579f2c16e46de807ec93_preview";
		const anonymousId = createProductAnalyticsStagingAnonymousId(runId);
		if (!anonymousId) throw new Error("Expected a staging anonymous ID");
		expect(anonymousId).toMatch(/^synthetic-[0-9a-f]{4}(?:x[0-9a-f]{4}){15}$/);
		expect(createProductAnalyticsStagingAnonymousId(runId)).toBe(anonymousId);
		expect(
			readProductAnalyticsBrowserTokenClaims(
				createProductAnalyticsBrowserToken(secret, anonymousId, now),
				secret,
				now,
			),
		).toEqual({ anonymousId });
		expect(
			createProductAnalyticsStagingAnonymousId("invalid run id"),
		).toBeUndefined();

		const response = NextResponse.next();
		response.cookies.set(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE, anonymousId);
		const serializedCookie = response.headers.get("set-cookie");
		const wireAnonymousId = serializedCookie?.match(
			new RegExp(`${PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE}=([^;]+)`),
		)?.[1];
		expect(wireAnonymousId).toBe(anonymousId);
	});

	it("reads only the analytics token cookie", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(
			readProductAnalyticsBrowserToken(
				`other=value; ${PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE}=${token}`,
			),
		).toBe(token);
		expect(readProductAnalyticsBrowserToken("other=value")).toBeUndefined();
	});
});
