import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

export const app = new Hono();

app.get(
	"/request",
	zValidator(
		"query",
		z.object({
			redirect_uri: z.string(),
			type: z.literal("api_key").default("api_key"),
		}),
	),
	async (c) => {
		const { redirect_uri } = c.req.valid("query");
		const url = new URL(c.req.url);

		const redirectOrigin = getDeploymentOrigin();

		const loginRedirectUrl = new URL(`${redirectOrigin}/login`);
		loginRedirectUrl.searchParams.set(
			"next",
			new URL(`${redirectOrigin}${url.pathname}${url.search}`).toString(),
		);

		const user = await getCurrentUser();
		if (!user) return c.redirect(loginRedirectUrl);

		const redirectTarget = parseRedirectUri(redirect_uri);
		if (!redirectTarget) return c.text("Invalid redirect_uri", 400);

		const id = crypto.randomUUID();
		await db().insert(authApiKeys).values({ id, userId: user.id });

		redirectTarget.searchParams.set("type", "api_key");
		redirectTarget.searchParams.set("api_key", id);
		redirectTarget.searchParams.set("user_id", user.id);

		return Response.redirect(redirectTarget.toString());
	},
);

function parseRedirectUri(value: string) {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") return null;
		if (!url.hostname.endsWith(".chromiumapp.org")) return null;
		return url;
	} catch {
		return null;
	}
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
