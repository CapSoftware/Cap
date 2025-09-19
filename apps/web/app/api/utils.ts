import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys, users } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { cookies } from "next/headers";

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
		if (authHeader)
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
