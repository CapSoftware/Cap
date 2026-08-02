import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { normalizeAnalyticsOpaqueIdentifier } from "@cap/analytics";

export const PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE =
	"cap_analytics_browser_token";
export const PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS = 60 * 60;

export function createProductAnalyticsAnonymousId() {
	return randomBytes(16).toString("base64url");
}

export function createProductAnalyticsStagingAnonymousId(
	stagingRunId: string | null,
) {
	if (!stagingRunId || !/^[A-Za-z0-9_-]{8,128}$/.test(stagingRunId)) {
		return undefined;
	}
	const digest = createHash("sha256").update(stagingRunId).digest("hex");
	const encodedDigest = Array.from({ length: 16 }, (_, index) =>
		digest.slice(index * 4, index * 4 + 4),
	).join("x");
	return `synthetic-${encodedDigest}`;
}

export function createProductAnalyticsBrowserToken(
	secret: string,
	anonymousId = createProductAnalyticsAnonymousId(),
	now = Date.now(),
) {
	const normalizedAnonymousId = normalizeAnalyticsOpaqueIdentifier(anonymousId);
	if (!normalizedAnonymousId) {
		throw new Error("Analytics anonymous ID is invalid");
	}
	const payload = `v1.${Math.floor(now / 1000)}.${normalizedAnonymousId}`;
	return `${payload}.${sign(payload, secret)}`;
}

export function readProductAnalyticsBrowserTokenClaims(
	token: string | undefined,
	secret: string,
	now = Date.now(),
) {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length !== 4 || parts[0] !== "v1") return undefined;
	const issuedAt = Number(parts[1]);
	if (!Number.isSafeInteger(issuedAt)) return undefined;
	const anonymousId = normalizeAnalyticsOpaqueIdentifier(parts[2]);
	if (!anonymousId) return undefined;
	const nowSeconds = Math.floor(now / 1000);
	if (
		issuedAt > nowSeconds + 60 ||
		nowSeconds - issuedAt > PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS
	) {
		return undefined;
	}
	const payload = parts.slice(0, 3).join(".");
	const expected = Buffer.from(sign(payload, secret));
	const actual = Buffer.from(parts[3] ?? "");
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return undefined;
	}
	return { anonymousId };
}

export function verifyProductAnalyticsBrowserToken(
	token: string | undefined,
	secret: string,
	now = Date.now(),
) {
	return Boolean(readProductAnalyticsBrowserTokenClaims(token, secret, now));
}

export function readProductAnalyticsBrowserToken(cookieHeader?: string) {
	for (const cookie of cookieHeader?.split(";") ?? []) {
		const [name, ...value] = cookie.trim().split("=");
		if (name === PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE) {
			return value.join("=");
		}
	}
}

function sign(payload: string, secret: string) {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}
