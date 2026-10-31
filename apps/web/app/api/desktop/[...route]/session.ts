import { db } from "@cap/database";
import { decodeSessionToken } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys, users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
	buildLoopbackCallbackUrl,
	createDesktopRedirectPage,
	desktopSessionRequestQuerySchema,
} from "@/lib/desktop-session";

export const app = new Hono();

app.get(
	"/request",
	zValidator("query", desktopSessionRequestQuerySchema),
	async (c) => {
		const { port, platform, type } = c.req.valid("query");

		const secret = serverEnv().NEXTAUTH_SECRET;

		const url = new URL(c.req.url);

		const redirectOrigin = getDeploymentOrigin();

		const loginRedirectUrl = new URL(`${redirectOrigin}/login`);
		loginRedirectUrl.searchParams.set(
			"next",
			new URL(`${redirectOrigin}${url.pathname}${url.search}`).toString(),
		);

		const user = await getCurrentUser();
		if (!user) return c.redirect(loginRedirectUrl);

		let data:
			| { type: "token"; token: string; expires: string }
			| { type: "api_key"; api_key: string };

		if (type === "session") {
			const token = getCookie(c, "next-auth.session-token");
			if (token === undefined) return c.redirect(loginRedirectUrl);

			const decodedToken = await decodeSessionToken({ token, secret });

			if (!decodedToken) return c.redirect(loginRedirectUrl);

			data = {
				type: "token",
				token,
				expires: String(decodedToken.exp),
			};
		} else {
			data = { type: "api_key", api_key: await createDesktopApiKey(user.id) };
		}

		const params = new URLSearchParams({ ...data, user_id: user.id });
		const localhostUrl =
			port !== undefined ? buildLoopbackCallbackUrl(port, params) : undefined;
		const deepLinkUrl = `cap-desktop://signin?${params}`;

		if (platform === "web" && localhostUrl) {
			return Response.redirect(localhostUrl);
		}

		if (platform === "desktop" && localhostUrl) {
			return new Response(
				createDesktopRedirectPage(deepLinkUrl, localhostUrl),
				{
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store, no-cache, must-revalidate",
						Pragma: "no-cache",
					},
				},
			);
		}

		return Response.redirect(deepLinkUrl);
	},
);

const MAX_DESKTOP_API_KEYS_PER_USER = 20;
const STALE_DESKTOP_API_KEY_BATCH = 1000;

async function createDesktopApiKey(userId: User.UserId) {
	const id = crypto.randomUUID();
	await db().transaction(async (tx) => {
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		await tx.insert(authApiKeys).values({ id, userId, source: "desktop" });
		for (;;) {
			const staleKeys = await tx
				.select({ id: authApiKeys.id })
				.from(authApiKeys)
				.where(
					and(
						eq(authApiKeys.userId, userId),
						eq(authApiKeys.source, "desktop"),
						ne(authApiKeys.id, id),
					),
				)
				.orderBy(desc(authApiKeys.createdAt), desc(authApiKeys.id))
				.limit(STALE_DESKTOP_API_KEY_BATCH)
				.offset(MAX_DESKTOP_API_KEYS_PER_USER - 1);
			if (staleKeys.length === 0) break;
			await tx.delete(authApiKeys).where(
				inArray(
					authApiKeys.id,
					staleKeys.map((key) => key.id),
				),
			);
			if (staleKeys.length < STALE_DESKTOP_API_KEY_BATCH) break;
		}
	});
	return id;
}

function getDeploymentOrigin() {
	const webUrl = serverEnv().WEB_URL;
	const vercelEnv = serverEnv().VERCEL_ENV;

	if (!vercelEnv || vercelEnv === "production") {
		return webUrl;
	}

	if (vercelEnv === "preview") {
		const branchHost = serverEnv().VERCEL_BRANCH_URL_HOST;
		if (branchHost?.endsWith(".vercel.app")) {
			return `https://${branchHost}`;
		}
	}

	return webUrl;
}
