import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	authApiKeys,
	developerApiKeys,
	developerAppDomains,
	developerApps,
	users,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { cookies } from "next/headers";
import { hashKey } from "@/lib/developer-key-hash";

async function getAuth(c: Context) {
	const authHeader = c.req.header("authorization")?.split(" ")[1];

	let user;

	if (authHeader?.length === 36) {
		const res = await db()
			.select()
			.from(users)
			.leftJoin(authApiKeys, eq(users.id, authApiKeys.userId))
			.where(eq(authApiKeys.id, authHeader));
		user = res[0]?.users;
	} else {
		if (authHeader && /^[a-zA-Z0-9._-]+$/.test(authHeader))
			(await cookies()).set({
				name: "next-auth.session-token",
				value: authHeader,
				path: "/",
				sameSite: "none",
				secure: true,
				httpOnly: true,
			});

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
	allowMethods: ["POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

export const developerSdkCors = cors({
	origin: "*",
	credentials: false,
	allowMethods: ["GET", "POST", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization"],
});

export const withDeveloperPublicAuth = createMiddleware<{
	Variables: {
		developerAppId: string;
		developerKeyType: "public";
	};
}>(async (c, next) => {
	const authHeader = c.req.header("authorization")?.split(" ")[1];
	if (!authHeader?.startsWith("cpk_")) {
		return c.json({ error: "Invalid public key" }, 401);
	}

	const keyHash = await hashKey(authHeader);
	const [keyRow] = await db()
		.select({ appId: developerApiKeys.appId })
		.from(developerApiKeys)
		.where(
			and(
				eq(developerApiKeys.keyHash, keyHash),
				eq(developerApiKeys.keyType, "public"),
				isNull(developerApiKeys.revokedAt),
			),
		)
		.limit(1);

	if (!keyRow) {
		return c.json({ error: "Invalid or revoked public key" }, 401);
	}

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(eq(developerApps.id, keyRow.appId), isNull(developerApps.deletedAt)),
		)
		.limit(1);

	if (!app) {
		return c.json({ error: "App not found" }, 401);
	}

	const origin = c.req.header("origin");
	if (app.environment === "production") {
		if (!origin) {
			return c.json(
				{ error: "Origin header required for production apps" },
				403,
			);
		}
		const [allowedDomain] = await db()
			.select()
			.from(developerAppDomains)
			.where(
				and(
					eq(developerAppDomains.appId, app.id),
					eq(developerAppDomains.domain, origin),
				),
			)
			.limit(1);

		if (!allowedDomain) {
			return c.json({ error: "Origin not allowed" }, 403);
		}
	}

	await db()
		.update(developerApiKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(developerApiKeys.keyHash, keyHash));

	c.set("developerAppId", app.id);
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
		return c.json({ error: "Invalid secret key" }, 401);
	}

	const keyHash = await hashKey(authHeader);
	const [keyRow] = await db()
		.select({ appId: developerApiKeys.appId })
		.from(developerApiKeys)
		.where(
			and(
				eq(developerApiKeys.keyHash, keyHash),
				eq(developerApiKeys.keyType, "secret"),
				isNull(developerApiKeys.revokedAt),
			),
		)
		.limit(1);

	if (!keyRow) {
		return c.json({ error: "Invalid or revoked secret key" }, 401);
	}

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(eq(developerApps.id, keyRow.appId), isNull(developerApps.deletedAt)),
		)
		.limit(1);

	if (!app) {
		return c.json({ error: "App not found" }, 401);
	}

	await db()
		.update(developerApiKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(developerApiKeys.keyHash, keyHash));

	c.set("developerAppId", app.id);
	c.set("developerKeyType", "secret" as const);
	await next();
});
