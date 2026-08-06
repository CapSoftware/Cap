import { db } from "@cap/database";
import { decodeSessionToken } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
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
			const id = crypto.randomUUID();
			await db()
				.insert(authApiKeys)
				.values({ id, userId: user.id, source: "desktop" });

			data = { type: "api_key", api_key: id };
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
