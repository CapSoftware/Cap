import { db } from "@cap/database";
import { isBlockedAccountEmail } from "@cap/database/auth/domain-utils";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	authApiKeys,
	developerApiKeys,
	developerAppDomains,
	developerApps,
	users,
} from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
	apiErrorBody,
	apiInternalErrorBody,
	apiNotFoundBody,
} from "@/lib/api-errors";
import { hashKey } from "@/lib/developer-key-hash";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_MAX_ENTRIES = 10_000;

const requestCounts = new Map<string, { count: number; resetAt: number }>();
let rateLimitRequestCounter = 0;

export const developerRateLimiter = createMiddleware(async (c, next) => {
	const key =
		c.req.header("authorization") ??
		c.req.header("x-forwarded-for") ??
		"unknown";
	const now = Date.now();

	rateLimitRequestCounter++;
	if (rateLimitRequestCounter % 100 === 0) {
		for (const [k, v] of requestCounts) {
			if (now > v.resetAt) requestCounts.delete(k);
		}
		if (requestCounts.size > RATE_LIMIT_MAX_ENTRIES) {
			for (const [k, v] of requestCounts) {
				if (requestCounts.size <= RATE_LIMIT_MAX_ENTRIES) break;
				if (v.count < RATE_LIMIT_MAX_REQUESTS) requestCounts.delete(k);
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

	const entry = requestCounts.get(key);

	if (!entry || now > entry.resetAt) {
		requestCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
	} else {
		entry.count++;
		if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
			c.header(
				"Retry-After",
				String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))),
			);
			return c.json(
				apiErrorBody(
					"rate_limited",
					"Rate limit exceeded",
					`Wait for the Retry-After seconds, then retry. Each key allows ${RATE_LIMIT_MAX_REQUESTS} requests per minute.`,
				),
				429,
			);
		}
	}

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

export const developerSdkCors = cors({
	origin: "*",
	credentials: false,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
});

function isOwnOrigin(origin: string) {
	try {
		return new URL(serverEnv().WEB_URL).origin === origin;
	} catch {
		return false;
	}
}

export const withDeveloperPublicAuth = createMiddleware<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>(async (c, next) => {
	const authHeader = c.req.header("authorization")?.split(" ")[1];
	if (!authHeader?.startsWith("cpk_")) {
		return c.json(
			apiErrorBody(
				"invalid_public_key",
				"Invalid public key",
				"Send Authorization: Bearer cpk_... with a public key from https://cap.so/dashboard/infra.",
			),
			401,
		);
	}

	const keyHash = await hashKey(authHeader);
	const [row] = await db()
		.select({
			appId: developerApps.id,
			environment: developerApps.environment,
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
				eq(developerApiKeys.keyType, "public"),
				isNull(developerApiKeys.revokedAt),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			apiErrorBody(
				"invalid_public_key",
				"Invalid or revoked public key",
				"Copy the current public key for your app from https://cap.so/dashboard/infra. Regenerating keys revokes the previous pair.",
			),
			401,
		);
	}

	const origin = c.req.header("origin");
	if (row.environment === "production") {
		if (!origin) {
			return c.json(
				apiErrorBody(
					"origin_required",
					"Origin header required for production apps",
					"Call the SDK API from a browser on an allowed domain, or use a development app for server-side testing.",
				),
				403,
			);
		}
		const [allowedDomain] = isOwnOrigin(origin)
			? [{ id: "self" }]
			: await db()
					.select({ id: developerAppDomains.id })
					.from(developerAppDomains)
					.where(
						and(
							eq(developerAppDomains.appId, row.appId),
							eq(developerAppDomains.domain, origin),
						),
					)
					.limit(1);

		if (!allowedDomain) {
			return c.json(
				apiErrorBody(
					"origin_not_allowed",
					"Origin not allowed",
					"Add this origin to the app's allowed domains at https://cap.so/dashboard/infra.",
				),
				403,
			);
		}
	}

	debouncedLastUsedUpdate(keyHash);

	c.set("developerAppId", row.appId);
	c.set("developerKeyType", "public" as const);
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

export const developerApiNotFound = (c: Context) =>
	c.json(apiNotFoundBody(new URL(c.req.url).pathname), 404);

export const developerApiError = (error: Error, c: Context) => {
	if (error instanceof HTTPException) return error.getResponse();
	console.error("Developer API error:", error);
	return c.json(apiInternalErrorBody(), 500);
};
