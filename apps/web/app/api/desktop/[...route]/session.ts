import { db } from "@cap/database";
import { decodeSessionToken } from "@cap/database/auth/auth-options";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys, users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { and, count, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
	buildDesktopCallbackParams,
	buildLoopbackCallbackUrl,
	createDesktopRedirectPage,
	desktopSessionRequestQuerySchema,
} from "@/lib/desktop-session";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { shouldRefuseTorExit } from "@/lib/tor-exit-gate";
import { zValidator } from "@/utils/zod-validator";

export const app = new Hono();

app.get(
	"/request",
	zValidator("query", desktopSessionRequestQuerySchema),
	async (c) => {
		const { port, platform, type, state } = c.req.valid("query");

		const secret = serverEnv().NEXTAUTH_SECRET;

		const url = new URL(c.req.url);

		const redirectOrigin = getDeploymentOrigin();

		const loginRedirectUrl = new URL(`${redirectOrigin}/login`);
		loginRedirectUrl.searchParams.set(
			"next",
			new URL(`${redirectOrigin}${url.pathname}${url.search}`).toString(),
		);

		if (await shouldRefuseTorExit("desktop-session", c.req.raw.headers)) {
			const blockedUrl = new URL(`${redirectOrigin}/login`);
			blockedUrl.searchParams.set("error", "SignupBlocked");
			return c.redirect(blockedUrl);
		}

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
			const apiKey = (await isRateLimited(RATE_LIMIT_IDS.DESKTOP_KEY_MINT, {
				key: `desktop-key-mint:${user.id}`,
				headers: c.req.raw.headers,
			}))
				? null
				: await createDesktopApiKey(user.id);
			if (!apiKey) {
				return c.text(
					"Too many sign-ins in the last hour. Try again later.",
					429,
					{
						"Retry-After": String(DESKTOP_API_KEY_WINDOW_MS / 1000),
					},
				);
			}
			data = { type: "api_key", api_key: apiKey };
		}

		const params = buildDesktopCallbackParams(data, user.id, state);
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
const DESKTOP_API_KEYS_PER_HOUR = 20;
const DESKTOP_API_KEY_WINDOW_MS = 60 * 60 * 1000;
const STALE_DESKTOP_API_KEY_BATCH = 1000;

async function createDesktopApiKey(userId: User.UserId) {
	const id = crypto.randomUUID();
	const minted = await db().transaction(async (tx) => {
		await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		const [recent] = await tx
			.select({ total: count() })
			.from(authApiKeys)
			.where(
				and(
					eq(authApiKeys.userId, userId),
					eq(authApiKeys.source, "desktop"),
					gt(
						authApiKeys.createdAt,
						new Date(Date.now() - DESKTOP_API_KEY_WINDOW_MS),
					),
				),
			);
		if (Number(recent?.total ?? 0) >= DESKTOP_API_KEYS_PER_HOUR) return false;
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
		return true;
	});
	return minted ? id : null;
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
