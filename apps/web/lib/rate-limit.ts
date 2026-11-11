import { checkRateLimit } from "@vercel/firewall";
import { headers as nextHeaders } from "next/headers";

const FIREWALL_FORWARDED_HEADER_NAMES = [
	"host",
	"x-real-ip",
	"x-forwarded-for",
	"x-vercel-id",
] as const;

export function firewallRequestHeaders(source: Headers): Headers {
	const headers = new Headers();
	for (const name of FIREWALL_FORWARDED_HEADER_NAMES) {
		const value = source.get(name);
		if (value) headers.set(name, value);
	}
	return headers;
}

/**
 * Per-key rate limiting backed by the Vercel Firewall, with an in-process
 * fallback.
 *
 * Each `ruleId` should also exist as a Rate Limit rule in the Vercel Firewall
 * dashboard with a `@vercel/firewall` condition matching the id. When the
 * firewall answers (allowed, limited or blocked) its decision is final. When it
 * cannot answer (non-production, rule not configured, missing client address
 * or any firewall error) the request is counted against a fixed-window limit
 * kept in this process (`FALLBACK_RATE_LIMITS`). That fallback is per instance,
 * so it is a backstop, not a replacement for the dashboard rule.
 *
 * @param ruleId   Stable rule id, also configured in the Vercel Firewall.
 * @param opts.key Optional bucket key (e.g. per-email / per-user). Defaults to
 *                 the caller IP.
 * @param opts.headers Optional request headers (required inside Hono handlers
 *                 where `next/headers` is unavailable; defaults to the App
 *                 Router request headers).
 * @returns `true` when the request should be rejected.
 */
export async function isRateLimited(
	ruleId: string,
	opts?: { key?: string; headers?: Headers },
): Promise<boolean> {
	try {
		const headersList = firewallRequestHeaders(
			opts?.headers ?? (await appRouterHeaders()),
		);
		const firewallDecision = await checkFirewallRateLimit(
			ruleId,
			headersList,
			opts?.key,
		);
		if (firewallDecision !== undefined) return firewallDecision;

		return await isLocallyRateLimited(ruleId, opts?.key, headersList);
	} catch (error) {
		console.warn(`Rate limit check failed for "${ruleId}":`, error);
		return false;
	}
}

async function appRouterHeaders(): Promise<Headers> {
	try {
		return new Headers(await nextHeaders());
	} catch {
		return new Headers();
	}
}

async function checkFirewallRateLimit(
	ruleId: string,
	headersList: Headers,
	key: string | undefined,
): Promise<boolean | undefined> {
	if (process.env.NODE_ENV !== "production") return undefined;

	try {
		const request = new Request("https://cap.so/api/rate-limit", {
			method: "POST",
			headers: headersList,
		});
		const result = await checkRateLimit(ruleId, {
			request,
			...(key ? { rateLimitKey: key } : {}),
		});
		return result.error === "not-found" ? undefined : result.rateLimited;
	} catch (error) {
		console.warn(`Rate limit check failed for "${ruleId}":`, error);
		return undefined;
	}
}

// Vercel overwrites x-real-ip and x-forwarded-for with the connecting address.
// Self-hosted proxies (nginx, Caddy, Traefik) append it to x-forwarded-for, so
// there only the last entry comes from infrastructure. IPv6 is grouped by /64,
// the block one host is normally assigned.
export function rateLimitClientAddress(
	headersList: Headers,
): string | undefined {
	const forwardedFor = headersList
		.get("x-forwarded-for")
		?.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const realIp = headersList.get("x-real-ip")?.trim();
	const address =
		process.env.VERCEL === "1"
			? realIp || forwardedFor?.[0]
			: forwardedFor?.at(-1) || realIp;
	return address ? clientNetwork(address) : undefined;
}

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

function clientNetwork(address: string): string {
	const value = address.toLowerCase();
	if (!value.includes(":")) return value;

	const mappedIpv4 = value.match(IPV4_MAPPED_IPV6)?.[1];
	if (mappedIpv4) return mappedIpv4;

	const halves = value.split("::");
	if (halves.length > 2) return value;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const elided = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (elided < 0 || (halves.length === 2 && elided === 0)) return value;

	const groups = [...head, ...Array<string>(elided).fill("0"), ...tail];
	if (groups.length !== 8 || !groups.every((group) => IPV6_GROUP.test(group)))
		return value;

	const network = groups
		.slice(0, 4)
		.map((group) => group.replace(/^0+(?=.)/, ""))
		.join(":");
	return `${network}::/64`;
}

/**
 * Canonical Vercel Firewall rate-limit rule ids introduced by the security
 * hardening pass. Each MUST be created in the Vercel Firewall dashboard for the
 * corresponding protection to take effect (see `isRateLimited`).
 */
export const RATE_LIMIT_IDS = {
	AGENT_TOKEN_EXCHANGE: "rl_agent_token_exchange",
	AGENT_AUTHORIZATION: "rl_agent_authorization",
	AGENT_UNLOCK: "rl_agent_unlock",
	AGENT_LOOM_IMPORT: "rl_loom_import_per_user",
	/** Email OTP verification attempts (brute-force guard). Suggested: 20 / 10m per key (email). */
	AUTH_OTP_VERIFY: "rl_auth_otp_verify",
	/** Email OTP / magic-link send (mailbomb + token-reseed guard). Suggested: 10 / 10m per key (email). */
	AUTH_OTP_SEND: "rl_auth_otp_send",
	/** Unauthed Loom download/convert (ffmpeg + memory DoS). Suggested: 10 / 1m per IP. */
	LOOM_DOWNLOAD: "rl_loom_download",
	/** Unauthed transcript translation (Groq cost). Suggested: 30 / 1m per IP. */
	TRANSLATE_TRANSCRIPT: "rl_translate_transcript",
	/** Anonymous support-chat messages (Groq + Supermemory cost). Suggested: 20 / 1m per IP. */
	MESSENGER_MESSAGE: "rl_messenger_message",
	/** Unauthed analytics view tracking (Tinybird ingest + notifications). Suggested: 120 / 1m per IP. */
	ANALYTICS_TRACK: "rl_analytics_track",
	/** Unauthed guest checkout (Stripe object/cost abuse). Suggested: 20 / 10m per IP. */
	GUEST_CHECKOUT: "rl_guest_checkout",
	/** Unauthed desktop log → Discord forwarding (spam). Suggested: 10 / 1m per IP. */
	DESKTOP_LOGS: "rl_desktop_logs",
	/** Mobile share password attempts (brute-force guard). Suggested: 20 / 10m per key (user). */
	MOBILE_VIDEO_PASSWORD: "rl_mobile_video_password",
	/** Unauthed docs Ask AI questions (Anthropic cost). Suggested: 10 / 1m per IP. */
	DOCS_ASK: "rl_docs_ask",
	AUTH_SSO_START: "rl_auth_sso_start",
	MCP_CLIENT_REGISTRATION: "rl_mcp_client_registration",
	/** Share-page video password attempts. Suggested: 20 / 10m per IP. */
	VIDEO_PASSWORD: "rl_video_password",
	/** Video password attempts across all clients. Suggested: 200 / 10m per key (video). */
	VIDEO_PASSWORD_PER_VIDEO: "rl_video_password_per_video",
	/** Public collection password attempts. Suggested: 20 / 10m per IP. */
	COLLECTION_PASSWORD: "rl_collection_password",
	/** Collection password attempts across all clients. Suggested: 200 / 10m per key (collection). */
	COLLECTION_PASSWORD_PER_COLLECTION: "rl_collection_password_per_collection",
	/** Invite emails: organization batches per organization and per sender, and video viewer invites per owner. Suggested: 30 / 1h per key. */
	ORGANIZATION_INVITE: "rl_organization_invite",
	CHECKOUT: "rl_checkout",
	VIDEO_PASSWORD_PER_VIEWER: "rl_video_password_per_viewer",
	COLLECTION_PASSWORD_PER_VIEWER: "rl_collection_password_per_viewer",
	/** Comments, replies and reactions per author. Suggested: 60 / 1m per key (user). */
	COMMENT_CREATE: "rl_comment_create",
	/** Video edit saves and restores per user: each one re-encodes the video and regenerates AI output. Suggested: 30 / 1h per key (user). */
	VIDEO_EDIT: "rl_video_edit",
	/** Share-page downloads by viewers who are not members. Suggested: 30 / 1m per IP. */
	VIEWER_DOWNLOAD: "rl_viewer_download",
} as const;

type FallbackRateLimit = { limit: number; windowMs: number };

const MINUTE_MS = 60_000;

const FALLBACK_RATE_LIMITS: Record<string, FallbackRateLimit> = {
	[RATE_LIMIT_IDS.AGENT_TOKEN_EXCHANGE]: { limit: 120, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.AGENT_AUTHORIZATION]: { limit: 10, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.AGENT_UNLOCK]: { limit: 30, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.AGENT_LOOM_IMPORT]: { limit: 20, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.AUTH_OTP_VERIFY]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.AUTH_OTP_SEND]: { limit: 10, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.LOOM_DOWNLOAD]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MESSENGER_MESSAGE]: { limit: 20, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.ANALYTICS_TRACK]: { limit: 120, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.GUEST_CHECKOUT]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.DESKTOP_LOGS]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MOBILE_VIDEO_PASSWORD]: {
		limit: 20,
		windowMs: 10 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.DOCS_ASK]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.AUTH_SSO_START]: { limit: 100, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MCP_CLIENT_REGISTRATION]: { limit: 60, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.VIDEO_PASSWORD]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.VIDEO_PASSWORD_PER_VIDEO]: {
		limit: 200,
		windowMs: 10 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.COLLECTION_PASSWORD]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.COLLECTION_PASSWORD_PER_COLLECTION]: {
		limit: 200,
		windowMs: 10 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.ORGANIZATION_INVITE]: { limit: 30, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.CHECKOUT]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.VIDEO_PASSWORD_PER_VIEWER]: {
		limit: 1,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.COLLECTION_PASSWORD_PER_VIEWER]: {
		limit: 1,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.VIDEO_EDIT]: { limit: 30, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.VIEWER_DOWNLOAD]: { limit: 30, windowMs: MINUTE_MS },
};

const DEFAULT_FALLBACK_RATE_LIMIT: FallbackRateLimit = {
	limit: 60,
	windowMs: MINUTE_MS,
};

// Off Vercel the app may be reached without a proxy, where every forwarded
// address is client-supplied, so keyless requests there also share one bucket
// per rule. A client behind a proxy cannot change the last forwarded entry, so
// it reaches its own limit before adding more than a tenth of that bucket.
const SHARED_LIMIT_MULTIPLIER = 10;
const MAX_LOCAL_BUCKETS = 10_000;
const LOCAL_BUCKET_SWEEP_INTERVAL_MS = 10_000;
const MAX_PLAIN_BUCKET_KEY_LENGTH = 256;

const localBuckets = new Map<string, { count: number; resetAt: number }>();
let nextLocalBucketSweepAt = 0;

async function isLocallyRateLimited(
	ruleId: string,
	key: string | undefined,
	headersList: Headers,
): Promise<boolean> {
	const rule = FALLBACK_RATE_LIMITS[ruleId] ?? DEFAULT_FALLBACK_RATE_LIMIT;
	if (key) {
		return countLocalRequest(
			`${ruleId}|key|${await compactBucketKey(key)}`,
			rule.limit,
			rule.windowMs,
		);
	}

	const address = rateLimitClientAddress(headersList);
	if (address) {
		const addressLimited = countLocalRequest(
			`${ruleId}|ip|${await compactBucketKey(address)}`,
			rule.limit,
			rule.windowMs,
		);
		if (addressLimited) return true;
		if (process.env.VERCEL === "1") return false;
	}

	return countLocalRequest(
		`${ruleId}|shared`,
		rule.limit * SHARED_LIMIT_MULTIPLIER,
		rule.windowMs,
	);
}

function countLocalRequest(
	bucketKey: string,
	limit: number,
	windowMs: number,
): boolean {
	const now = Date.now();
	const bucket = localBuckets.get(bucketKey);
	if (bucket && bucket.resetAt > now) {
		bucket.count += 1;
		return bucket.count > limit;
	}

	localBuckets.delete(bucketKey);
	reserveLocalBucket(now);
	localBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
	return limit < 1;
}

function reserveLocalBucket(now: number) {
	if (localBuckets.size < MAX_LOCAL_BUCKETS) return;
	if (now >= nextLocalBucketSweepAt) {
		nextLocalBucketSweepAt = now + LOCAL_BUCKET_SWEEP_INTERVAL_MS;
		for (const [key, bucket] of localBuckets) {
			if (bucket.resetAt <= now) localBuckets.delete(key);
		}
	}
	for (const key of localBuckets.keys()) {
		if (localBuckets.size < MAX_LOCAL_BUCKETS) return;
		localBuckets.delete(key);
	}
}

async function compactBucketKey(key: string): Promise<string> {
	if (key.length <= MAX_PLAIN_BUCKET_KEY_LENGTH) return key;
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key),
	);
	return `sha256:${Buffer.from(digest).toString("hex")}`;
}
