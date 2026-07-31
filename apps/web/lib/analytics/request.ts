import { createHash } from "node:crypto";
import {
	isServerOnlyEventName,
	normalizeProductEventInput,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
} from "@cap/analytics";
import { isSocialCrawlerUserAgent } from "@/lib/social-crawlers";

interface AnalyticsRequestHeaders {
	authorization?: string;
	contentLength?: string;
	origin?: string;
	secFetchSite?: string;
}

interface ProductAnalyticsRateLimiterOptions {
	perKeyLimit?: number;
	globalLimit?: number;
	windowMs?: number;
	maxKeys?: number;
}

const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site"]);
const ANONYMOUS_BROWSER_EVENT_NAMES = new Set([
	"page_view",
	"page_engagement",
	"download_cta_clicked",
	"pricing_cta_clicked",
	"cli_install_command_copied",
	"auth_started",
	"auth_email_sent",
	"tool_interaction",
	"experiment_exposed",
]);

export class ProductAnalyticsRateLimiter {
	private readonly buckets = new Map<
		string,
		{ count: number; resetAt: number }
	>();
	private globalCount = 0;
	private globalResetAt = 0;
	private checks = 0;
	private readonly perKeyLimit: number;
	private readonly globalLimit: number;
	private readonly windowMs: number;
	private readonly maxKeys: number;

	constructor(options: ProductAnalyticsRateLimiterOptions = {}) {
		this.perKeyLimit = options.perKeyLimit ?? 120;
		this.globalLimit = options.globalLimit ?? 5_000;
		this.windowMs = options.windowMs ?? 60_000;
		this.maxKeys = options.maxKeys ?? 10_000;
	}

	isRateLimited(key: string, now = Date.now()) {
		if (now >= this.globalResetAt) {
			this.globalCount = 0;
			this.globalResetAt = now + this.windowMs;
		}
		this.globalCount += 1;
		if (this.globalCount > this.globalLimit) return true;

		this.checks += 1;
		if (this.checks % 100 === 0) {
			for (const [bucketKey, bucket] of this.buckets) {
				if (now >= bucket.resetAt) this.buckets.delete(bucketKey);
			}
		}

		const bucketKey =
			this.buckets.has(key) || this.buckets.size < this.maxKeys
				? key
				: "overflow";
		const bucket = this.buckets.get(bucketKey);
		if (!bucket || now >= bucket.resetAt) {
			this.buckets.set(bucketKey, { count: 1, resetAt: now + this.windowMs });
			return false;
		}

		bucket.count += 1;
		return bucket.count > this.perKeyLimit;
	}
}

export function hasExpectedBrowserAnalyticsMetadata(
	headers: AnalyticsRequestHeaders,
	allowedOrigins: readonly string[],
) {
	if (!hasValidContentLength(headers.contentLength)) return false;

	const secFetchSite = headers.secFetchSite?.toLowerCase();
	if (!headers.origin || !allowedOrigins.includes(headers.origin)) return false;
	if (!secFetchSite || !ALLOWED_FETCH_SITES.has(secFetchSite)) return false;

	return true;
}

export function isAuthenticatedAnalyticsRequestCandidate(
	headers: AnalyticsRequestHeaders,
) {
	if (!hasValidContentLength(headers.contentLength)) return false;
	const token = headers.authorization?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
	return token?.length === 36;
}

export function shouldRejectUnresolvedAuthenticatedAnalyticsRequest({
	actorResolved,
	authorizationCandidate,
	hasSessionCookie,
}: {
	actorResolved: boolean;
	authorizationCandidate: boolean;
	hasSessionCookie: boolean;
}) {
	return !actorResolved && (authorizationCandidate || hasSessionCookie);
}

export function isAllowedAnonymousBrowserProductEvent(
	event: ProductEventInput,
	anonymousId: string,
) {
	return (
		event.platform === "web" &&
		event.anonymousId === anonymousId &&
		ANONYMOUS_BROWSER_EVENT_NAMES.has(event.eventName)
	);
}

function hasValidContentLength(value?: string) {
	if (!value) return true;
	const contentLength = Number(value);
	return (
		Number.isSafeInteger(contentLength) &&
		contentLength >= 0 &&
		contentLength <= PRODUCT_ANALYTICS_LIMITS.requestBytes
	);
}

export function normalizeProductEventBatch(
	values: readonly unknown[],
	now = Date.now(),
): ProductEventInput[] | null {
	if (
		new TextEncoder().encode(JSON.stringify({ events: values })).byteLength >
		PRODUCT_ANALYTICS_LIMITS.requestBytes
	) {
		return null;
	}

	if (
		values.length === 0 ||
		values.length > PRODUCT_ANALYTICS_LIMITS.batchSize
	) {
		return null;
	}

	const events: ProductEventInput[] = [];
	for (const value of values) {
		const event = normalizeProductEventInput(value, now);
		if (!event || isServerOnlyEventName(event.eventName)) return null;
		events.push(event);
	}
	return events;
}

export function getProductAnalyticsRateLimitKey(headers: {
	trustedVercelProxy: boolean;
	xVercelForwardedFor?: string;
	fallbackIdentity?: string;
}) {
	if (!headers.trustedVercelProxy) {
		const identity = headers.fallbackIdentity?.trim();
		if (!identity) return null;
		return `self-hosted:${createHash("sha256").update(identity).digest("hex")}`;
	}
	const identity = headers.xVercelForwardedFor?.split(",")[0]?.trim();
	return identity
		? identity.slice(0, PRODUCT_ANALYTICS_LIMITS.identifierLength)
		: null;
}

export function normalizeGeoHeader(value?: string, decode = false) {
	if (!value) return undefined;
	let normalized = value;
	if (decode) {
		try {
			normalized = decodeURIComponent(value);
		} catch {
			return undefined;
		}
	}
	const trimmed = normalized.trim().slice(0, 128);
	return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

export function normalizeAnalyticsHostname(origin?: string) {
	if (!origin) return undefined;
	try {
		return new URL(origin).hostname.toLowerCase().slice(0, 253);
	} catch {
		return undefined;
	}
}

export function isKnownAnalyticsBot(userAgent?: string) {
	if (!userAgent) return true;
	return (
		isSocialCrawlerUserAgent(userAgent) ||
		/(?:bot\b|crawler|spider|headless|lighthouse|pagespeed|pingdom|uptimerobot|synthetic|preview)/i.test(
			userAgent,
		)
	);
}

export function normalizeSyntheticRunId(
	value: string | undefined,
	vercelEnvironment: "production" | "preview" | "development" | undefined,
) {
	if (vercelEnvironment !== "preview" || !value) return undefined;
	return /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;
}

export function classifyAnalyticsTraffic({
	userAgent,
	vercelEnvironment,
	syntheticRunId,
	rateLimitKey,
	internalIpHashes,
}: {
	userAgent?: string;
	vercelEnvironment?: "production" | "preview" | "development";
	syntheticRunId?: string;
	rateLimitKey: string;
	internalIpHashes?: string;
}) {
	if (syntheticRunId) return "synthetic" as const;
	if (vercelEnvironment === "preview") return "preview" as const;
	if (isKnownAnalyticsBot(userAgent)) return "bot" as const;
	const hashes = new Set(
		internalIpHashes
			?.split(",")
			.map((value) => value.trim().toLowerCase())
			.filter((value) => /^[0-9a-f]{64}$/.test(value)) ?? [],
	);
	const requestHash = createHash("sha256").update(rateLimitKey).digest("hex");
	if (hashes.has(requestHash)) return "internal" as const;
	return "external" as const;
}
