import { db } from "@cap/database";
import { isBlockedAccountEmail } from "@cap/database/auth/domain-utils";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	authApiKeys,
	developerApiKeys,
	developerApps,
	developerVideos,
	users,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
	apiErrorBody,
	apiInternalErrorBody,
	apiMethodNotAllowedBody,
	apiNotFoundBody,
} from "@/lib/api-errors";
import { hashKey } from "@/lib/developer-key-hash";
import {
	DEVELOPER_KEY_REQUESTS_PER_MINUTE,
	DEVELOPER_OWNER_REQUESTS_PER_MINUTE,
	DEVELOPER_RATE_LIMIT_WINDOW_SECONDS,
	DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
} from "@/lib/developer-rate-limits";
import {
	CREATE_UPLOAD_PATH,
	isDeveloperPublicKey,
	missingUploadTokenRefusal,
	publicKeyRefusal,
	UPLOAD_TOKEN_MAX_SECONDS,
	UPLOAD_TOKEN_PREFIX,
	uploadTokenRefusal,
	verifyDeveloperUploadToken,
} from "@/lib/developer-upload-token";
import {
	isRateLimited,
	RATE_LIMIT_IDS,
	rateLimitClientAddress,
	sharedRateLimitDecision,
} from "@/lib/rate-limit";

const RATE_LIMIT_WINDOW_MS = DEVELOPER_RATE_LIMIT_WINDOW_SECONDS * 1000;
const RATE_LIMIT_MAX_ENTRIES = 10_000;

type DeveloperRateLimit = { ruleId: string; limit: number; subject: string };
type DeveloperWindow = {
	limited: boolean;
	shared: boolean;
	count: number;
	resetAt: number;
};

const requestCounts = new Map<
	string,
	{ count: number; resetAt: number; limit: number }
>();
let rateLimitRequestCounter = 0;

async function credentialDigest(credential: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(credential),
	);
	return Buffer.from(digest).toString("hex");
}

function sweepRequestCounts(now: number) {
	rateLimitRequestCounter++;
	if (rateLimitRequestCounter % 100 !== 0) return;
	for (const [k, v] of requestCounts) {
		if (now > v.resetAt) requestCounts.delete(k);
	}
	if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) return;
	for (const [k, v] of requestCounts) {
		if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) break;
		if (v.count < v.limit) requestCounts.delete(k);
	}
	if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) return;
	const byExpiry = [...requestCounts.entries()].sort(
		(a, b) => a[1].resetAt - b[1].resetAt,
	);
	for (const [k] of byExpiry) {
		if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) break;
		requestCounts.delete(k);
	}
}

// The firewall rule counts a bucket across every server instance and its
// answer is final. The window kept here fills the headers, and decides only
// when the firewall cannot answer. A 429 from the rule waits a whole window,
// because this instance cannot see when the shared one began. Only a
// credential that has already been accepted is counted, so a caller without
// one cannot fill this map or spend a firewall call.
async function countDeveloperRequest(
	c: Context,
	{ ruleId, limit }: DeveloperRateLimit,
	bucket: string,
	sharedKey: string,
): Promise<DeveloperWindow> {
	const key = `${ruleId}|${bucket}`;
	const now = Date.now();
	sweepRequestCounts(now);

	let entry = requestCounts.get(key);
	if (!entry || now > entry.resetAt) {
		entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS, limit };
		requestCounts.set(key, entry);
	} else {
		entry.count++;
	}
	const { count, resetAt } = entry;

	const shared = await sharedRateLimitDecision(ruleId, {
		key: sharedKey,
		headers: c.req.raw.headers,
	});
	return {
		limited: shared ?? count > limit,
		shared: shared !== undefined,
		count,
		resetAt,
	};
}

function resetSeconds(window: DeveloperWindow): string {
	return String(
		window.shared && window.limited
			? DEVELOPER_RATE_LIMIT_WINDOW_SECONDS
			: Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000)),
	);
}

function setRateLimitHeaders(
	c: Context,
	{ limit }: DeveloperRateLimit,
	window: DeveloperWindow,
) {
	c.header("X-RateLimit-Limit", String(limit));
	c.header(
		"X-RateLimit-Remaining",
		String(window.limited ? 0 : Math.max(0, limit - window.count)),
	);
	c.header("X-RateLimit-Reset", resetSeconds(window));
}

function rateLimited(
	c: Context,
	{ limit, subject }: DeveloperRateLimit,
	window: DeveloperWindow,
) {
	c.header("Retry-After", resetSeconds(window));
	return c.json(
		apiErrorBody(
			"rate_limited",
			"Rate limit exceeded",
			`Wait for the Retry-After seconds, then retry. Each ${subject} allows ${limit} requests per minute.`,
		),
		429,
	);
}

const KEY_RATE_LIMIT: DeveloperRateLimit = {
	ruleId: RATE_LIMIT_IDS.DEVELOPER_API_KEY,
	limit: DEVELOPER_KEY_REQUESTS_PER_MINUTE,
	subject: "key",
};
const OWNER_RATE_LIMIT: DeveloperRateLimit = {
	ruleId: RATE_LIMIT_IDS.DEVELOPER_API_OWNER,
	limit: DEVELOPER_OWNER_REQUESTS_PER_MINUTE,
	subject: "account, across all of its keys,",
};
const UPLOAD_TOKEN_RATE_LIMIT: DeveloperRateLimit = {
	ruleId: RATE_LIMIT_IDS.DEVELOPER_UPLOAD_TOKEN,
	limit: DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
	subject: "upload token",
};

// A credential that was refused is remembered with the address that sent it,
// so sending it again is refused at once: no lookup, and it does not count
// again. A different credential from the same address is still looked up, so a
// customer whose stale worker keeps sending a rotated key, from the same server
// as their live traffic, keeps working. Only an address sending many different
// refused credentials (an attacker trying keys) is stopped outright, which
// bounds the lookups it can cause. A key this instance accepted within the
// last minute is let through even then.
const blockedAddresses = new Map<string, number>();
const refusedCredentials = new Map<string, number>();
const pendingLookups = new Map<string, Promise<DeveloperSecretKey | null>>();
const acceptedAt = new Map<string, number>();

function refusedKey(address: string, digest: string) {
	return `${address}|${digest}`;
}

function refusedRecently(address: string, digest: string): boolean {
	const key = refusedKey(address, digest);
	const until = refusedCredentials.get(key);
	if (until === undefined) return false;
	if (until > Date.now()) return true;
	refusedCredentials.delete(key);
	return false;
}

function rememberRefused(address: string, digest: string) {
	const now = Date.now();
	if (refusedCredentials.size >= RATE_LIMIT_MAX_ENTRIES) {
		for (const [key, until] of refusedCredentials) {
			if (until <= now) refusedCredentials.delete(key);
		}
		if (refusedCredentials.size >= RATE_LIMIT_MAX_ENTRIES) {
			refusedCredentials.clear();
		}
	}
	refusedCredentials.set(
		refusedKey(address, digest),
		now + RATE_LIMIT_WINDOW_MS,
	);
}

function recentlyAccepted(credential: string): boolean {
	const at = acceptedAt.get(credential);
	return at !== undefined && Date.now() - at < RATE_LIMIT_WINDOW_MS;
}

function rememberAccepted(credential: string) {
	const now = Date.now();
	if (
		!acceptedAt.has(credential) &&
		acceptedAt.size >= RATE_LIMIT_MAX_ENTRIES
	) {
		for (const [key, at] of acceptedAt) {
			if (now - at >= RATE_LIMIT_WINDOW_MS) acceptedAt.delete(key);
		}
		if (acceptedAt.size >= RATE_LIMIT_MAX_ENTRIES) acceptedAt.clear();
	}
	acceptedAt.set(credential, now);
}

function authFailuresBlocked(c: Context): boolean {
	const address = rateLimitClientAddress(c.req.raw.headers);
	if (!address) return false;
	const until = blockedAddresses.get(address);
	if (until === undefined) return false;
	if (until > Date.now()) return true;
	blockedAddresses.delete(address);
	return false;
}

async function tooManyAuthFailures(c: Context): Promise<boolean> {
	const limited = await isRateLimited(RATE_LIMIT_IDS.DEVELOPER_AUTH_FAILURE, {
		headers: c.req.raw.headers,
	});
	const address = limited
		? rateLimitClientAddress(c.req.raw.headers)
		: undefined;
	if (address) {
		const now = Date.now();
		if (blockedAddresses.size >= RATE_LIMIT_MAX_ENTRIES) {
			for (const [blocked, until] of blockedAddresses) {
				if (until <= now) blockedAddresses.delete(blocked);
			}
			if (blockedAddresses.size >= RATE_LIMIT_MAX_ENTRIES) {
				blockedAddresses.clear();
			}
		}
		blockedAddresses.set(address, now + RATE_LIMIT_WINDOW_MS);
	}
	return limited;
}

function authFailuresLimited(c: Context) {
	c.header("Retry-After", String(DEVELOPER_RATE_LIMIT_WINDOW_SECONDS));
	return c.json(
		apiErrorBody(
			"rate_limited",
			"Too many requests with a key or token that was not accepted",
			"Wait for the Retry-After seconds, then retry with a valid key or upload token.",
		),
		429,
	);
}

const bearerCredential = (c: Context) =>
	c.req.header("authorization")?.trim().split(/\s+/)[1];

// Every key issued is csk_ and 30 characters from a 32 letter alphabet. Any
// credential outside this shape is refused without being hashed or looked up.
const SECRET_KEY_SHAPE = /^csk_[A-Za-z0-9_-]{1,124}$/;

type DeveloperSecretKey = { appId: string; keyId: string; ownerId: string };

async function findDeveloperSecretKey(
	credential: string,
): Promise<DeveloperSecretKey | null> {
	const keyHash = await hashKey(credential);
	const [row] = await db()
		.select({
			appId: developerApps.id,
			keyId: developerApiKeys.id,
			ownerId: developerApps.ownerId,
		})
		.from(developerApiKeys)
		.innerJoin(
			developerApps,
			and(
				eq(developerApiKeys.appId, developerApps.id),
				isNull(developerApps.deletedAt),
			),
		)
		.where(
			and(
				eq(developerApiKeys.keyHash, keyHash),
				eq(developerApiKeys.keyType, "secret"),
				isNull(developerApiKeys.revokedAt),
			),
		)
		.limit(1);
	if (!row) return null;
	debouncedLastUsedUpdate(keyHash);
	return row;
}

const unknownSecretKey = () =>
	apiErrorBody(
		"invalid_secret_key",
		"Invalid or revoked secret key",
		"Copy the current secret key for your app from https://cap.so/dashboard/infra. Regenerating keys revokes the previous pair.",
	);

type DeveloperSecretVariables = {
	developerAppId: string;
	developerKeyId: string;
	developerOwnerId: string;
	developerKeyType: "secret";
};

// Every path that accepts a secret key sets the same variables, so a route
// gets the key's id whichever middleware looked it up.
function setDeveloperSecretKey(
	c: Context<{ Variables: DeveloperSecretVariables }>,
	key: DeveloperSecretKey,
) {
	c.set("developerAppId", key.appId);
	c.set("developerKeyId", key.keyId);
	c.set("developerOwnerId", key.ownerId);
	c.set("developerKeyType", "secret");
}

// A request without a well formed key costs nothing here and is answered by
// the route. A well formed key is looked up once: an unknown one counts
// against the address that sent it, a known one against its own budget and
// its owner's.
export const developerRateLimiter = createMiddleware<{
	Variables: DeveloperSecretVariables;
}>(async (c, next) => {
	const credential = bearerCredential(c);
	if (!credential || !SECRET_KEY_SHAPE.test(credential)) return next();
	if (authFailuresBlocked(c) && !recentlyAccepted(credential)) {
		return authFailuresLimited(c);
	}
	const address = rateLimitClientAddress(c.req.raw.headers);
	const digest = await credentialDigest(credential);
	if (address && refusedRecently(address, digest)) {
		return c.json(unknownSecretKey(), 401);
	}

	// Requests with the same credential from the same address share one lookup,
	// and only that lookup counts a refusal, so a burst of retries with a
	// rotated key counts once however many arrive before it finishes.
	const pairKey = address ? refusedKey(address, digest) : null;
	let pending = pairKey ? pendingLookups.get(pairKey) : undefined;
	const leads = pending === undefined;
	if (!pending) {
		pending = findDeveloperSecretKey(credential);
		if (pairKey) {
			pendingLookups.set(pairKey, pending);
			void pending.then(
				() => pendingLookups.delete(pairKey),
				() => pendingLookups.delete(pairKey),
			);
		}
	}
	const key = await pending;
	if (!key) {
		if (!leads) return c.json(unknownSecretKey(), 401);
		if (address) rememberRefused(address, digest);
		if (await tooManyAuthFailures(c)) return authFailuresLimited(c);
		return c.json(unknownSecretKey(), 401);
	}
	setDeveloperSecretKey(c, key);
	rememberAccepted(credential);

	const [byKey, byOwner] = await Promise.all([
		countDeveloperRequest(c, KEY_RATE_LIMIT, credential, digest),
		countDeveloperRequest(c, OWNER_RATE_LIMIT, key.ownerId, key.ownerId),
	]);
	setRateLimitHeaders(c, KEY_RATE_LIMIT, byKey);
	if (byKey.limited) return rateLimited(c, KEY_RATE_LIMIT, byKey);
	if (byOwner.limited) {
		c.header("X-RateLimit-Remaining", "0");
		c.header("X-RateLimit-Reset", resetSeconds(byOwner));
		return rateLimited(c, OWNER_RATE_LIMIT, byOwner);
	}
	await next();
});

// A token is checked by its signature alone, so this costs no lookup. One
// that was never issued counts against the address that sent it, and the
// route still gives the refusal its usual wording.
export const developerUploadRateLimiter = createMiddleware(async (c, next) => {
	const credential = bearerCredential(c);
	if (!credential?.startsWith(UPLOAD_TOKEN_PREFIX)) return next();

	const check = verifyDeveloperUploadToken(credential);
	if (!check.ok) {
		if (
			check.reason === "invalid" &&
			(authFailuresBlocked(c) || (await tooManyAuthFailures(c)))
		) {
			return authFailuresLimited(c);
		}
		return next();
	}

	const window = await countDeveloperRequest(
		c,
		UPLOAD_TOKEN_RATE_LIMIT,
		credential,
		await credentialDigest(credential),
	);
	setRateLimitHeaders(c, UPLOAD_TOKEN_RATE_LIMIT, window);
	if (window.limited) return rateLimited(c, UPLOAD_TOKEN_RATE_LIMIT, window);
	await next();
});

const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
const lastUsedWriteTimes = new Map<string, number>();

function debouncedLastUsedUpdate(keyHash: string) {
	const now = Date.now();
	const lastWrite = lastUsedWriteTimes.get(keyHash);
	if (lastWrite && now - lastWrite < LAST_USED_DEBOUNCE_MS) return;
	lastUsedWriteTimes.set(keyHash, now);
	db()
		.update(developerApiKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(developerApiKeys.keyHash, keyHash))
		.catch((err) => console.error("Failed to update lastUsedAt:", err));
}

async function getAuth(c: Context) {
	const authHeader = c.req.header("authorization")?.split(" ")[1];

	let user: Awaited<ReturnType<typeof getCurrentUser>> | undefined;

	if (authHeader?.length === 36) {
		const res = await db()
			.select()
			.from(users)
			.leftJoin(authApiKeys, eq(users.id, authApiKeys.userId))
			.where(eq(authApiKeys.id, authHeader));
		user = res[0]?.users;
		if (user && isBlockedAccountEmail(user.email)) user = undefined;
	} else if (!isCrossSiteCookieWrite(c.req.raw)) {
		user = await getCurrentUser();
	}

	if (!user) return;
	return { user };
}

export const withOptionalAuth = createMiddleware<{
	Variables: {
		user?: Awaited<ReturnType<typeof getCurrentUser>>;
	};
}>(async (c, next) => {
	const auth = await getAuth(c);

	if (auth) c.set("user", auth.user);

	await next();
});

export const withAuth = createMiddleware<{
	Variables: {
		user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
	};
}>(async (c, next) => {
	const auth = await getAuth(c);
	if (!auth) return c.text("User not authenticated", 401);

	c.set("user", auth.user);

	await next();
});

export const allowedOrigins = [
	buildEnv.NEXT_PUBLIC_WEB_URL,
	"http://localhost:3001",
	"http://localhost:3000",
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
];

export const corsMiddleware = cors({
	origin: allowedOrigins,
	credentials: true,
	allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

export const developerResponseHeaders = createMiddleware(async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
	const requestId = c.req.header("x-vercel-id");
	if (requestId) c.header("X-Request-Id", requestId);
});

export const developerSdkCors = cors({
	origin: "*",
	credentials: false,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
	maxAge: 7200,
	exposeHeaders: [
		"Retry-After",
		"X-RateLimit-Limit",
		"X-RateLimit-Remaining",
		"X-RateLimit-Reset",
		"X-Request-Id",
	],
});

export const refuseDeveloperPublicKey = createMiddleware(async (c, next) => {
	if (isDeveloperPublicKey(bearerCredential(c))) {
		return c.json(publicKeyRefusal(), 403);
	}
	await next();
});

const UNKEYED_UPLOAD_TOKEN = "";

export const withDeveloperUploadToken = createMiddleware<{
	Variables: {
		developerAppId: string;
		developerVideoId: string;
		developerUploadCompleted: boolean;
		developerUploadMaxBytes: number | null;
	};
}>(async (c, next) => {
	const credential = bearerCredential(c);
	if (!credential?.startsWith(UPLOAD_TOKEN_PREFIX)) {
		return c.json(missingUploadTokenRefusal(credential), 401);
	}

	const check = verifyDeveloperUploadToken(credential);
	if (!check.ok) return c.json(uploadTokenRefusal(check.reason), 401);
	const { appId, videoId, corsOrigin, maxBytes, keyId } = check.token;

	if (corsOrigin !== null && c.req.header("origin") !== corsOrigin) {
		return c.json(
			apiErrorBody(
				"origin_not_allowed",
				"Origin not allowed for this upload token",
				`This token only works from ${corsOrigin}. Create the upload with the corsOrigin of the page that uploads, or leave corsOrigin out.`,
			),
			403,
		);
	}

	const [video] = await db()
		.select({
			duration: developerVideos.duration,
			deletedAt: developerVideos.deletedAt,
			keyId: developerApiKeys.id,
			keyRevokedAt: developerApiKeys.revokedAt,
		})
		.from(developerVideos)
		.innerJoin(
			developerApps,
			and(
				eq(developerVideos.appId, developerApps.id),
				isNull(developerApps.deletedAt),
			),
		)
		.leftJoin(
			developerApiKeys,
			and(
				eq(developerApiKeys.id, keyId ?? UNKEYED_UPLOAD_TOKEN),
				eq(developerApiKeys.appId, developerVideos.appId),
				eq(developerApiKeys.keyType, "secret"),
			),
		)
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		)
		.limit(1);

	if (!video || video.deletedAt) {
		return c.json(
			apiErrorBody(
				"video_not_found",
				"The video for this upload token no longer exists",
				`Create a new upload with POST ${CREATE_UPLOAD_PATH}.`,
			),
			404,
		);
	}

	if (keyId === undefined) {
		const [revoked] = await db()
			.select({ id: developerApiKeys.id })
			.from(developerApiKeys)
			.where(
				and(
					eq(developerApiKeys.appId, appId),
					eq(developerApiKeys.keyType, "secret"),
					gt(
						developerApiKeys.revokedAt,
						new Date(check.token.expiresAt - UPLOAD_TOKEN_MAX_SECONDS * 1000),
					),
				),
			)
			.limit(1);
		if (revoked) return c.json(uploadTokenRefusal("rotated"), 401);
	} else if (video.keyId === null || video.keyRevokedAt) {
		return c.json(uploadTokenRefusal("rotated"), 401);
	}

	c.set("developerAppId", appId);
	c.set("developerVideoId", videoId);
	c.set("developerUploadCompleted", video.duration !== null);
	c.set("developerUploadMaxBytes", maxBytes ?? null);
	await next();
});

export const withDeveloperSecretAuth = createMiddleware<{
	Variables: DeveloperSecretVariables;
}>(async (c, next) => {
	// Only a secret key the rate limiter already accepted skips the lookup. An
	// app id set by any other middleware, such as an upload token's, does not.
	if (c.get("developerAppId") && c.get("developerKeyType") === "secret") {
		return next();
	}

	if (!c.req.header("authorization")?.trim()) {
		return c.json(
			apiErrorBody(
				"invalid_secret_key",
				"Missing secret key",
				"No Authorization header was sent. Send Authorization: Bearer csk_... with a secret key from https://cap.so/dashboard/infra.",
			),
			401,
		);
	}
	const credential = bearerCredential(c);
	if (isDeveloperPublicKey(credential)) {
		return c.json(
			apiErrorBody(
				"public_key_not_allowed",
				"Public keys cannot call the REST API",
				"A public key (cpk_) was sent. The REST API takes the app's secret key: send Authorization: Bearer csk_... from your server, with the secret key from https://cap.so/dashboard/infra.",
			),
			403,
		);
	}
	if (!credential || !SECRET_KEY_SHAPE.test(credential)) {
		return c.json(
			apiErrorBody(
				"invalid_secret_key",
				"Invalid secret key",
				"Send Authorization: Bearer csk_... with a secret key from https://cap.so/dashboard/infra.",
			),
			401,
		);
	}

	const key = await findDeveloperSecretKey(credential);
	if (!key) return c.json(unknownSecretKey(), 401);

	setDeveloperSecretKey(c, key);
	await next();
});

type DeveloperApiRoute = { method: string; path: string };

const routeMatches = (pattern: string, pathname: string) => {
	const expected = pattern.split("/");
	const actual = pathname.split("/");
	return (
		expected.length === actual.length &&
		expected.every((segment, index) =>
			segment.startsWith(":")
				? actual[index] !== ""
				: segment === actual[index],
		)
	);
};

export const developerApiNotFound = (
	c: Context,
	routes: readonly DeveloperApiRoute[] = [],
) => {
	const pathname = new URL(c.req.url).pathname;
	const allowed = [
		...new Set(
			routes
				.filter(
					(route) =>
						route.method !== "ALL" && routeMatches(route.path, pathname),
				)
				.map((route) => route.method),
		),
	];
	if (allowed.length === 0) return c.json(apiNotFoundBody(pathname), 404);
	c.header("Allow", allowed.join(", "));
	return c.json(apiMethodNotAllowedBody(c.req.method, pathname, allowed), 405);
};

export const developerApiError = (error: Error, c: Context) => {
	if (error instanceof HTTPException) {
		return c.json(
			apiErrorBody(
				"invalid_request",
				error.message || "The request could not be processed",
				"Check the request against the OpenAPI description at /openapi.json.",
			),
			error.status,
		);
	}
	console.error("Developer API error:", error);
	return c.json(apiInternalErrorBody(), 500);
};
