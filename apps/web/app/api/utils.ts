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
import { and, eq, isNull } from "drizzle-orm";
import type { Context, Next } from "hono";
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
	DEVELOPER_RATE_LIMIT_WINDOW_SECONDS,
	DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
} from "@/lib/developer-rate-limits";
import {
	CREATE_UPLOAD_PATH,
	isDeveloperPublicKey,
	missingUploadTokenRefusal,
	publicKeyRefusal,
	UPLOAD_TOKEN_PREFIX,
	uploadTokenRefusal,
	verifyDeveloperUploadToken,
} from "@/lib/developer-upload-token";
import { RATE_LIMIT_IDS, sharedRateLimitDecision } from "@/lib/rate-limit";

const RATE_LIMIT_WINDOW_MS = DEVELOPER_RATE_LIMIT_WINDOW_SECONDS * 1000;
const RATE_LIMIT_MAX_ENTRIES = 10_000;

type DeveloperRateLimit = { ruleId: string; limit: number; subject: string };

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

// The firewall rule counts a credential across every server instance and its
// answer is final. The window kept here fills the headers, and decides only
// when the firewall cannot answer. A 429 from the rule waits a whole window,
// because this instance cannot see when the shared one began.
async function limitDeveloperRequest(
	c: Context,
	next: Next,
	{ ruleId, limit, subject }: DeveloperRateLimit,
) {
	const credential =
		c.req.header("authorization")?.trim().split(/\s+/)[1] ??
		c.req.header("x-forwarded-for") ??
		"unknown";
	const key = `${ruleId}|${credential}`;
	const now = Date.now();

	rateLimitRequestCounter++;
	if (rateLimitRequestCounter % 100 === 0) {
		for (const [k, v] of requestCounts) {
			if (now > v.resetAt) requestCounts.delete(k);
		}
		if (requestCounts.size > RATE_LIMIT_MAX_ENTRIES) {
			for (const [k, v] of requestCounts) {
				if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) break;
				if (v.count < v.limit) requestCounts.delete(k);
			}
			if (requestCounts.size > RATE_LIMIT_MAX_ENTRIES) {
				const byExpiry = [...requestCounts.entries()].sort(
					(a, b) => a[1].resetAt - b[1].resetAt,
				);
				for (const [k] of byExpiry) {
					if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) break;
					requestCounts.delete(k);
				}
			}
		}
	}

	let entry = requestCounts.get(key);

	if (!entry || now > entry.resetAt) {
		entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS, limit };
		requestCounts.set(key, entry);
	} else {
		entry.count++;
	}
	const { count, resetAt } = entry;

	const shared = await sharedRateLimitDecision(ruleId, {
		key: await credentialDigest(credential),
		headers: c.req.raw.headers,
	});
	const limited = shared ?? count > limit;

	const resetSeconds = String(
		shared
			? DEVELOPER_RATE_LIMIT_WINDOW_SECONDS
			: Math.max(1, Math.ceil((resetAt - now) / 1000)),
	);
	c.header("X-RateLimit-Limit", String(limit));
	c.header(
		"X-RateLimit-Remaining",
		String(limited ? 0 : Math.max(0, limit - count)),
	);
	c.header("X-RateLimit-Reset", resetSeconds);

	if (limited) {
		c.header("Retry-After", resetSeconds);
		return c.json(
			apiErrorBody(
				"rate_limited",
				"Rate limit exceeded",
				`Wait for the Retry-After seconds, then retry. Each ${subject} allows ${limit} requests per minute.`,
			),
			429,
		);
	}

	await next();
}

const developerRateLimit = (rule: DeveloperRateLimit) =>
	createMiddleware((c, next) => limitDeveloperRequest(c, next, rule));

export const developerRateLimiter = developerRateLimit({
	ruleId: RATE_LIMIT_IDS.DEVELOPER_API_KEY,
	limit: DEVELOPER_KEY_REQUESTS_PER_MINUTE,
	subject: "key",
});

export const developerUploadRateLimiter = developerRateLimit({
	ruleId: RATE_LIMIT_IDS.DEVELOPER_UPLOAD_TOKEN,
	limit: DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
	subject: "upload token",
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

export const developerSdkCors = cors({
	origin: "*",
	credentials: false,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
	exposeHeaders: [
		"Retry-After",
		"X-RateLimit-Limit",
		"X-RateLimit-Remaining",
		"X-RateLimit-Reset",
	],
});

const bearerCredential = (c: Context) =>
	c.req.header("authorization")?.trim().split(/\s+/)[1];

export const refuseDeveloperPublicKey = createMiddleware(async (c, next) => {
	if (isDeveloperPublicKey(bearerCredential(c))) {
		return c.json(publicKeyRefusal(), 403);
	}
	await next();
});

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
	const { appId, videoId, corsOrigin, maxBytes } = check.token;

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
		})
		.from(developerVideos)
		.innerJoin(
			developerApps,
			and(
				eq(developerVideos.appId, developerApps.id),
				isNull(developerApps.deletedAt),
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

	c.set("developerAppId", appId);
	c.set("developerVideoId", videoId);
	c.set("developerUploadCompleted", video.duration !== null);
	c.set("developerUploadMaxBytes", maxBytes ?? null);
	await next();
});

export const withDeveloperSecretAuth = createMiddleware<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>(async (c, next) => {
	const authHeader = c.req.header("authorization")?.split(" ")[1];
	if (!authHeader?.startsWith("csk_")) {
		return c.json(
			apiErrorBody(
				"invalid_secret_key",
				"Invalid secret key",
				"Send Authorization: Bearer csk_... with a secret key from https://cap.so/dashboard/infra.",
			),
			401,
		);
	}

	const keyHash = await hashKey(authHeader);
	const [row] = await db()
		.select({ appId: developerApps.id })
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

	if (!row) {
		return c.json(
			apiErrorBody(
				"invalid_secret_key",
				"Invalid or revoked secret key",
				"Copy the current secret key for your app from https://cap.so/dashboard/infra. Regenerating keys revokes the previous pair.",
			),
			401,
		);
	}

	debouncedLastUsedUpdate(keyHash);

	c.set("developerAppId", row.appId);
	c.set("developerKeyType", "secret" as const);
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
