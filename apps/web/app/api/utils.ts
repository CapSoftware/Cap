import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { createMiddleware } from "hono/factory";
import { clientEnv, serverEnv } from "@cap/env";
import { cors } from "hono/cors";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@cap/database/auth/auth-options";
import { Context } from "hono";

async function getAuth(c: Context) {
	const token = c.req.header("authorization")?.split(" ")[1];
	if (token) {
		cookies().set({
			name: "next-auth.session-token",
			value: token,
			path: "/",
			sameSite: "none",
			secure: true,
			httpOnly: true,
		});
	}

	const session = await getServerSession(authOptions);
	if (!session) return;
	const user = await getCurrentUser(session);
	if (!user) return;

	return { session, user };
}

export const withOptionalAuth = createMiddleware<{
	Variables: {
		user?: Awaited<ReturnType<typeof getCurrentUser>>;
		session?: Session;
	};
}>(async (c, next) => {
	const auth = await getAuth(c);

	if (auth) {
		c.set("session", auth.session);
		c.set("user", auth.user);
	}

	await next();
});

export const withAuth = createMiddleware<{
	Variables: {
		user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
		session: Session;
	};
}>(async (c, next) => {
	const auth = await getAuth(c);
	if (!auth) return c.text("User not authenticated", 401);

	c.set("session", auth.session);
	c.set("user", auth.user);

	await next();
});

const allowedOrigins = [
	serverEnv.WEB_URL,
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
