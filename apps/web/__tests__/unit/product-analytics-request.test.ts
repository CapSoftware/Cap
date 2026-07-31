import {
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
} from "@cap/analytics";
import { describe, expect, it } from "vitest";
import {
	getProductAnalyticsRateLimitKey,
	hasExpectedBrowserAnalyticsMetadata,
	isAllowedAnonymousBrowserProductEvent,
	isAuthenticatedAnalyticsRequestCandidate,
	normalizeGeoHeader,
	normalizeProductEventBatch,
	ProductAnalyticsRateLimiter,
	shouldRejectUnresolvedAuthenticatedAnalyticsRequest,
} from "@/lib/analytics/request";
import { getVercelDeploymentOrigins } from "@/lib/analytics/vercel-origins";

const allowedOrigins = ["https://cap.so", "tauri://localhost"];
const event: ProductEventInput = {
	eventId: "event-1",
	eventName: "page_view",
	occurredAt: "2026-07-12T12:00:00.000Z",
	anonymousId: "anonymous-1",
	sessionId: "session-1",
	platform: "web",
	properties: {
		hostname: "cap.so",
		is_session_entry: true,
	},
};
const now = Date.parse("2026-07-12T12:00:01.000Z");

describe("getVercelDeploymentOrigins", () => {
	it("allows only the current Vercel deployment and branch hosts", () => {
		expect(
			getVercelDeploymentOrigins({
				VERCEL_URL: "cap-abc123.vercel.app",
				VERCEL_BRANCH_URL: "cap-git-feature.vercel.app",
			}),
		).toEqual([
			"https://cap-abc123.vercel.app",
			"https://cap-git-feature.vercel.app",
		]);
	});

	it("rejects malformed and non-Vercel hosts", () => {
		expect(
			getVercelDeploymentOrigins({
				VERCEL_URL: "attacker.example",
				VERCEL_BRANCH_URL: "attacker.example@cap.vercel.app",
			}),
		).toEqual([]);
	});
});

describe("hasExpectedBrowserAnalyticsMetadata", () => {
	it.each([
		[
			"same-origin browser",
			{ origin: "https://cap.so", secFetchSite: "same-origin" },
		],
		[
			"same-site browser",
			{ origin: "https://cap.so", secFetchSite: "same-site" },
		],
	])("accepts %s", (_label, headers) => {
		expect(hasExpectedBrowserAnalyticsMetadata(headers, allowedOrigins)).toBe(
			true,
		);
	});

	it("rejects cross-site browser requests", () => {
		expect(
			hasExpectedBrowserAnalyticsMetadata(
				{ origin: "https://attacker.example", secFetchSite: "cross-site" },
				allowedOrigins,
			),
		).toBe(false);
	});

	it("rejects requests without browser metadata", () => {
		expect(hasExpectedBrowserAnalyticsMetadata({}, allowedOrigins)).toBe(false);
		expect(
			hasExpectedBrowserAnalyticsMetadata(
				{ origin: "https://cap.so" },
				allowedOrigins,
			),
		).toBe(false);
		expect(
			hasExpectedBrowserAnalyticsMetadata(
				{ origin: "https://cap.so", secFetchSite: "none" },
				allowedOrigins,
			),
		).toBe(false);
	});

	it("allows API-key requests to attempt actor resolution", () => {
		expect(
			isAuthenticatedAnalyticsRequestCandidate({
				authorization: `Bearer ${"a".repeat(36)}`,
			}),
		).toBe(true);
		expect(
			isAuthenticatedAnalyticsRequestCandidate({
				authorization: "Bearer invalid",
			}),
		).toBe(false);
		expect(
			isAuthenticatedAnalyticsRequestCandidate({
				authorization: `Bearer ${"a".repeat(36)} extra`,
			}),
		).toBe(false);
		expect(
			isAuthenticatedAnalyticsRequestCandidate({
				authorization: `Bearer ${"a".repeat(36)}`,
				origin: "https://attacker.example",
			}),
		).toBe(true);
	});

	it("allows only bounded top-of-funnel web events without an actor", () => {
		expect(isAllowedAnonymousBrowserProductEvent(event, "anonymous-1")).toBe(
			true,
		);
		expect(
			isAllowedAnonymousBrowserProductEvent(
				{ ...event, eventName: "recording_started" },
				"anonymous-1",
			),
		).toBe(false);
		expect(
			isAllowedAnonymousBrowserProductEvent(
				{ ...event, anonymousId: "attacker-chosen" },
				"anonymous-1",
			),
		).toBe(false);
		expect(
			isAllowedAnonymousBrowserProductEvent(
				{ ...event, platform: "desktop" },
				"anonymous-1",
			),
		).toBe(false);
	});

	it("fails closed when a supplied authenticated identity no longer resolves", () => {
		expect(
			shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
				actorResolved: false,
				authorizationCandidate: true,
				hasSessionCookie: false,
			}),
		).toBe(true);
		expect(
			shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
				actorResolved: false,
				authorizationCandidate: false,
				hasSessionCookie: true,
			}),
		).toBe(true);
		expect(
			shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
				actorResolved: true,
				authorizationCandidate: true,
				hasSessionCookie: true,
			}),
		).toBe(false);
		expect(
			shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
				actorResolved: false,
				authorizationCandidate: false,
				hasSessionCookie: false,
			}),
		).toBe(false);
	});

	it("rejects oversized declared bodies", () => {
		expect(
			hasExpectedBrowserAnalyticsMetadata(
				{ contentLength: String(PRODUCT_ANALYTICS_LIMITS.requestBytes + 1) },
				allowedOrigins,
			),
		).toBe(false);
	});

	it.each(["invalid", "-1", "1.5"])(
		"rejects malformed content length %s",
		(contentLength) => {
			expect(
				hasExpectedBrowserAnalyticsMetadata({ contentLength }, allowedOrigins),
			).toBe(false);
		},
	);
});

describe("normalizeProductEventBatch", () => {
	it("accepts a bounded valid batch", () => {
		expect(normalizeProductEventBatch([event], now)).toEqual([event]);
	});

	it("rejects an empty batch", () => {
		expect(normalizeProductEventBatch([], now)).toBeNull();
	});

	it("rejects a batch above the cap", () => {
		expect(
			normalizeProductEventBatch(
				Array.from(
					{ length: PRODUCT_ANALYTICS_LIMITS.batchSize + 1 },
					() => event,
				),
				now,
			),
		).toBeNull();
	});

	it("rejects the whole batch when one event is invalid", () => {
		expect(
			normalizeProductEventBatch(
				[event, { ...event, eventName: "$autocapture" }],
				now,
			),
		).toBeNull();
	});

	it("rejects an undeclared oversized body", () => {
		expect(
			normalizeProductEventBatch(
				[
					{
						...event,
						properties: {
							value: "x".repeat(PRODUCT_ANALYTICS_LIMITS.requestBytes),
						},
					},
				],
				now,
			),
		).toBeNull();
	});

	it.each([
		"user_signed_up",
		"checkout_started",
		"guest_checkout_started",
		"purchase_completed",
	] as const)("rejects client-authored %s", (eventName) => {
		expect(
			normalizeProductEventBatch([{ ...event, eventName }], now),
		).toBeNull();
	});
});

describe("ProductAnalyticsRateLimiter", () => {
	it("enforces per-key and process-wide fallback limits", () => {
		const limiter = new ProductAnalyticsRateLimiter({
			perKeyLimit: 2,
			globalLimit: 4,
			windowMs: 1_000,
		});
		expect(limiter.isRateLimited("a", 0)).toBe(false);
		expect(limiter.isRateLimited("a", 0)).toBe(false);
		expect(limiter.isRateLimited("a", 0)).toBe(true);
		expect(limiter.isRateLimited("b", 0)).toBe(false);
		expect(limiter.isRateLimited("c", 0)).toBe(true);
		expect(limiter.isRateLimited("a", 1_000)).toBe(false);
	});

	it("uses a platform-owned proxy identity or hashed self-hosted identity", () => {
		expect(
			getProductAnalyticsRateLimitKey({
				trustedVercelProxy: true,
				xVercelForwardedFor: "203.0.113.10, 10.0.0.1",
			}),
		).toBe("203.0.113.10");
		expect(
			getProductAnalyticsRateLimitKey({
				trustedVercelProxy: false,
				xVercelForwardedFor: "attacker-controlled",
				fallbackIdentity: "browser-1",
			}),
		).toMatch(/^self-hosted:[0-9a-f]{64}$/);
		expect(
			getProductAnalyticsRateLimitKey({
				trustedVercelProxy: false,
				fallbackIdentity: "browser-1",
			}),
		).not.toBe(
			getProductAnalyticsRateLimitKey({
				trustedVercelProxy: false,
				fallbackIdentity: "browser-2",
			}),
		);
		expect(
			getProductAnalyticsRateLimitKey({ trustedVercelProxy: true }),
		).toBeNull();
		expect(
			getProductAnalyticsRateLimitKey({ trustedVercelProxy: false }),
		).toBeNull();
	});
});

describe("normalizeGeoHeader", () => {
	it("decodes and bounds a city header", () => {
		expect(normalizeGeoHeader("Nicosia%20Centre", true)).toBe("Nicosia Centre");
	});

	it("rejects malformed encoded data", () => {
		expect(normalizeGeoHeader("%E0%A4%A", true)).toBeUndefined();
	});

	it("removes unknown values", () => {
		expect(normalizeGeoHeader("unknown")).toBeUndefined();
	});
});
