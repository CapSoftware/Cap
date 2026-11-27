import { checkRateLimit } from "@vercel/firewall";
import { headers as nextHeaders } from "next/headers";
import { DEVELOPER_AUTH_FAILURES_PER_MINUTE } from "@/lib/developer-rate-limits";

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

/**
 * The firewall's decision for a keyed rule, or `undefined` when it cannot
 * answer: the cases in which `isRateLimited` falls back to its own window.
 * For callers that keep and report their own window, such as the developer
 * API, and need to know whether the shared rule decided.
 */
export function sharedRateLimitDecision(
	ruleId: string,
	opts: { key: string; headers: Headers },
): Promise<boolean | undefined> {
	return checkFirewallRateLimit(
		ruleId,
		firewallRequestHeaders(opts.headers),
		opts.key,
	);
}

/**
 * Charges `units` against a firewall rule by issuing that many checks at once,
 * so a request can cost more than one hit in a single round trip. Returns
 * `true` when any check is limited, `false` when every check was allowed, and
 * `undefined` when the firewall could not answer at least one of them (the
 * caller then applies its own fallback).
 */
export async function checkFirewallRateLimitUnits(
	ruleId: string,
	opts: { key: string; units: number; headers: Headers },
): Promise<boolean | undefined> {
	if (opts.units < 1) return false;
	const headersList = firewallRequestHeaders(opts.headers);
	const decisions = await Promise.all(
		Array.from({ length: opts.units }, () =>
			checkFirewallRateLimit(ruleId, headersList, opts.key),
		),
	);
	if (decisions.includes(true)) return true;
	return decisions.includes(undefined) ? undefined : false;
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
export function clientAddress(headersList: Headers): string | undefined {
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
	return address || undefined;
}

export function rateLimitClientAddress(
	headersList: Headers,
): string | undefined {
	const address = clientAddress(headersList);
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
	/** Support-chat update polls. An open chat polls at most every 3 s, slower when idle. Suggested: 120 / 1m per IP. */
	MESSENGER_POLL: "rl_messenger_poll",
	/** Unauthed analytics view tracking (Tinybird ingest + notifications). Suggested: 120 / 1m per IP. */
	ANALYTICS_TRACK: "rl_analytics_track",
	/** Unauthed guest checkout (Stripe object/cost abuse). Suggested: 20 / 10m per IP. */
	GUEST_CHECKOUT: "rl_guest_checkout",
	/** Unauthed desktop log → Discord forwarding (spam). Suggested: 10 / 1m per IP. */
	DESKTOP_LOGS: "rl_desktop_logs",
	/** Signed-in desktop feedback emails. Suggested: 10 / 1h per key (user). */
	DESKTOP_FEEDBACK: "rl_desktop_feedback",
	/** Desktop app keys issued per account, counted apart from the keys that sign-out deletes. Suggested: 20 / 1h per key (user). */
	DESKTOP_KEY_MINT: "rl_desktop_key_mint",
	/** Authenticated desktop upload speed and storage health probes. Suggested: 4 / 1m per key (user). */
	DESKTOP_UPLOAD_HEALTH: "rl_desktop_upload_health",
	/** Mobile share password attempts (brute-force guard). Suggested: 20 / 10m per key (user). */
	MOBILE_VIDEO_PASSWORD: "rl_mobile_video_password",
	/** Unauthed docs Ask AI questions (Anthropic cost). Suggested: 10 / 1m per IP. */
	DOCS_ASK: "rl_docs_ask",
	AUTH_SSO_START: "rl_auth_sso_start",
	/** Passkey sign-in ceremonies, counted when one starts and when one completes. Suggested: 30 / 1m per IP. */
	AUTH_PASSKEY: "rl_auth_passkey",
	/** Google One Tap sign-in attempts. Suggested: 30 / 1m per IP. */
	AUTH_GOOGLE_ONE_TAP: "rl_auth_google_one_tap",
	MCP_CLIENT_REGISTRATION: "rl_mcp_client_registration",
	/** Share-page video password attempts. Suggested: 20 / 10m per IP. */
	VIDEO_PASSWORD: "rl_video_password",
	/**
	 * Password attempts across all clients, per video or collection. Keys are
	 * prefixed `video:` or `collection:`, so the two never share a bucket.
	 * Suggested: 200 / 10m per key.
	 */
	PASSWORD_PER_RESOURCE: "rl_video_password_per_video",
	/** Public collection password attempts. Suggested: 20 / 10m per IP. */
	COLLECTION_PASSWORD: "rl_collection_password",
	/** Invite emails: organization batches per organization and per sender, and video viewer invites per owner. Suggested: 30 / 1h per key. */
	ORGANIZATION_INVITE: "rl_organization_invite",
	CHECKOUT: "rl_checkout",
	/** Password attempts per video or collection and viewer, keyed like PASSWORD_PER_RESOURCE. Suggested: 1 / 1h per key. */
	PASSWORD_PER_VIEWER: "rl_video_password_per_viewer",
	/** Comments, replies and reactions per author. Suggested: 60 / 1m per key (user). */
	COMMENT_CREATE: "rl_comment_create",
	/** Comment media upload starts per viewer. Suggested: 60 / 1h per key (user). */
	COMMENT_MEDIA_UPLOAD: "rl_comment_media_upload",
	/** Transcription and AI generation retries per user, from the share page and the agent API. Suggested: 30 / 1h per key (user). */
	PROCESSING_RETRY: "rl_processing_retry",
	/** Organizations created from the dashboard per user. Suggested: 20 / 1h per key (user). */
	ORGANIZATION_CREATE: "rl_organization_create",
	/** Spaces created from the dashboard per user. Suggested: 300 / 1h per key (user). */
	SPACE_CREATE: "rl_space_create",
	/** Video edit saves and restores per user: each one re-encodes the video and regenerates AI output. Suggested: 30 / 1h per key (user). */
	VIDEO_EDIT: "rl_video_edit",
	/** Share-page downloads by viewers who are not members. Suggested: 30 / 1m per IP. */
	VIEWER_DOWNLOAD: "rl_viewer_download",
	/** Usage event batches from the iOS app (OpenPanel ingest). Suggested: 30 / 1m per key (user). */
	MOBILE_EVENTS: "rl_mobile_events",
	/** Code attempts on Cap Infra credit checkout (guessing guard). Suggested: 10 / 10m per key (user). */
	INFRA_CREDIT_CODE: "rl_infra_credit_code",
	/** Developer apps created from the console and the agent API. Suggested: 10 / 1h per key (user). */
	DEVELOPER_APP_CREATE: "rl_developer_app_create",
	/** Developer key rotations from the console and the agent API. Suggested: 10 / 1h per key (user). */
	DEVELOPER_KEY_ROTATE: "rl_developer_key_rotate",
	/** Developer REST API requests per secret key. 300 / 1m per key (hash of the credential). */
	DEVELOPER_API_KEY: "rl_developer_api_key",
	/** Developer SDK upload requests per upload token. 1200 / 1m per key (hash of the credential). */
	DEVELOPER_UPLOAD_TOKEN: "rl_developer_upload_token",
	/** Developer REST API requests per account, across all of its keys. 1200 / 1m per key (owner id). */
	DEVELOPER_API_OWNER: "rl_developer_api_owner",
	/** Developer API requests whose key or upload token was not accepted. 300 / 1m per IP. */
	DEVELOPER_AUTH_FAILURE: "rl_developer_auth_failure",
	/** Desktop meeting clip transcription (speech provider cost). Suggested: 1200 / 1h per key (user). */
	MEETINGS_TRANSCRIBE: "rl_meetings_transcribe",
	/** Desktop meeting notes generation (LLM cost): one unit per request plus one per started 100 KB of body past the first. Suggested: 60 / 1h per key (user). */
	MEETINGS_NOTES: "rl_meetings_notes",
	/** Desktop meeting questions (LLM cost): one unit per request plus one per started 100 KB of body past the first. Suggested: 120 / 1h per key (user). */
	MEETINGS_ASK: "rl_meetings_ask",
	/** Desktop meeting audio, charged one unit per started 10 s of audio (see `checkFirewallRateLimitUnits`). Suggested: 720 / 1h per key (user). Firewall windows stop at one hour; the daily cap is kept in the database (lib/meetings/audio-usage.ts). */
	MEETINGS_AUDIO: "rl_meetings_audio",
	/** Desktop meeting requests whose sign-in was not accepted. Suggested: 60 / 1m per IP. */
	MEETINGS_AUTH_FAILURE: "rl_meetings_auth_failure",
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
	[RATE_LIMIT_IDS.AUTH_PASSKEY]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.AUTH_GOOGLE_ONE_TAP]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.LOOM_DOWNLOAD]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.TRANSLATE_TRANSCRIPT]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MESSENGER_MESSAGE]: { limit: 20, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MESSENGER_POLL]: { limit: 120, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.ANALYTICS_TRACK]: { limit: 120, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.GUEST_CHECKOUT]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.DESKTOP_LOGS]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.DESKTOP_FEEDBACK]: { limit: 10, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.DESKTOP_KEY_MINT]: { limit: 20, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.DESKTOP_UPLOAD_HEALTH]: { limit: 4, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MOBILE_VIDEO_PASSWORD]: {
		limit: 20,
		windowMs: 10 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.DOCS_ASK]: { limit: 10, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.AUTH_SSO_START]: { limit: 100, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MCP_CLIENT_REGISTRATION]: { limit: 60, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.VIDEO_PASSWORD]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.PASSWORD_PER_RESOURCE]: {
		limit: 200,
		windowMs: 10 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.COLLECTION_PASSWORD]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.ORGANIZATION_INVITE]: { limit: 30, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.CHECKOUT]: { limit: 20, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.PASSWORD_PER_VIEWER]: {
		limit: 1,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.COMMENT_MEDIA_UPLOAD]: {
		limit: 60,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.PROCESSING_RETRY]: { limit: 30, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.ORGANIZATION_CREATE]: {
		limit: 20,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.SPACE_CREATE]: { limit: 300, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.VIDEO_EDIT]: { limit: 30, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.VIEWER_DOWNLOAD]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.MOBILE_EVENTS]: { limit: 30, windowMs: MINUTE_MS },
	[RATE_LIMIT_IDS.INFRA_CREDIT_CODE]: { limit: 10, windowMs: 10 * MINUTE_MS },
	[RATE_LIMIT_IDS.DEVELOPER_APP_CREATE]: {
		limit: 10,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.DEVELOPER_KEY_ROTATE]: {
		limit: 10,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.DEVELOPER_AUTH_FAILURE]: {
		limit: DEVELOPER_AUTH_FAILURES_PER_MINUTE,
		windowMs: MINUTE_MS,
	},
	[RATE_LIMIT_IDS.MEETINGS_TRANSCRIBE]: {
		limit: 1200,
		windowMs: 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.MEETINGS_NOTES]: { limit: 60, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.MEETINGS_ASK]: { limit: 120, windowMs: 60 * MINUTE_MS },
	[RATE_LIMIT_IDS.MEETINGS_AUDIO]: {
		limit: 5_760,
		windowMs: 24 * 60 * MINUTE_MS,
	},
	[RATE_LIMIT_IDS.MEETINGS_AUTH_FAILURE]: { limit: 60, windowMs: MINUTE_MS },
};

const DEFAULT_FALLBACK_RATE_LIMIT: FallbackRateLimit = {
	limit: 60,
	windowMs: MINUTE_MS,
};

export function getFallbackRateLimit(ruleId: string): FallbackRateLimit {
	return FALLBACK_RATE_LIMITS[ruleId] ?? DEFAULT_FALLBACK_RATE_LIMIT;
}

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
	const rule = getFallbackRateLimit(ruleId);
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

export type RollingBudgetRule = { limit: number; windowMs: number };

export type RollingBudgetDecision =
	| { allowed: true; used: number }
	| { allowed: false; retryAfterSeconds: number };

const ROLLING_BUDGET_SLOTS_PER_WINDOW = 60;

const rollingBudgetBuckets = new Map<string, Map<number, number>>();

export function rollingBudgetSlotMs(rule: RollingBudgetRule): number {
	return Math.max(
		1,
		Math.ceil(rule.windowMs / ROLLING_BUDGET_SLOTS_PER_WINDOW),
	);
}

// A slot keeps counting while any part of it overlaps the window, so usage is
// over-counted by at most one slot and never under-counted.
function isRollingSlotLive(
	slot: number,
	slotMs: number,
	rule: RollingBudgetRule,
	now: number,
): boolean {
	return (slot + 1) * slotMs > now - rule.windowMs;
}

export function decideRollingBudget(
	slots: ReadonlyMap<number, number>,
	rule: RollingBudgetRule,
	cost: number,
	now: number,
): RollingBudgetDecision {
	const slotMs = rollingBudgetSlotMs(rule);
	const live = [...slots]
		.filter(([slot]) => isRollingSlotLive(slot, slotMs, rule, now))
		.sort(([left], [right]) => left - right);
	const used = live.reduce((total, [, value]) => total + value, 0);
	if (used + cost <= rule.limit) return { allowed: true, used: used + cost };

	let remaining = used;
	for (const [slot, value] of live) {
		remaining -= value;
		if (remaining + cost <= rule.limit) {
			const freedAt = (slot + 1) * slotMs + rule.windowMs;
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil((freedAt - now) / 1000)),
			};
		}
	}
	return {
		allowed: false,
		retryAfterSeconds: Math.max(1, Math.ceil(rule.windowMs / 1000)),
	};
}

/**
 * Cost-weighted rolling-window budget kept in this process. Unlike the
 * firewall rules it can charge a request by its cost (for example seconds of
 * audio) and reports when enough of the window frees up, but it is per
 * instance like the `isRateLimited` fallback.
 */
export async function consumeRollingBudget(
	ruleId: string,
	opts: { key: string; rule: RollingBudgetRule; cost?: number; now?: number },
): Promise<RollingBudgetDecision> {
	const cost = opts.cost ?? 1;
	const bucketKey = `${ruleId}|key|${await compactBucketKey(opts.key)}`;
	const now = opts.now ?? Date.now();
	const slotMs = rollingBudgetSlotMs(opts.rule);
	const existing = rollingBudgetBuckets.get(bucketKey);
	const slots = existing ?? new Map<number, number>();
	for (const slot of slots.keys()) {
		if (!isRollingSlotLive(slot, slotMs, opts.rule, now)) slots.delete(slot);
	}

	const decision = decideRollingBudget(slots, opts.rule, cost, now);
	if (!decision.allowed) return decision;

	const slot = Math.floor(now / slotMs);
	slots.set(slot, (slots.get(slot) ?? 0) + cost);
	if (!existing) {
		reserveRollingBudgetBucket();
		rollingBudgetBuckets.set(bucketKey, slots);
	}
	return decision;
}

function reserveRollingBudgetBucket() {
	if (rollingBudgetBuckets.size < MAX_LOCAL_BUCKETS) return;
	for (const [key, slots] of rollingBudgetBuckets) {
		if (slots.size === 0) rollingBudgetBuckets.delete(key);
	}
	for (const key of rollingBudgetBuckets.keys()) {
		if (rollingBudgetBuckets.size < MAX_LOCAL_BUCKETS) return;
		rollingBudgetBuckets.delete(key);
	}
}
