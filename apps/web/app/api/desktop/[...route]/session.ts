import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { decode } from "next-auth/jwt";
import { z } from "zod";

export const app = new Hono();

function createDesktopRedirectPage(primaryUrl: string, fallbackUrl: string) {
	const state = JSON.stringify({ primaryUrl, fallbackUrl });

	return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate" />
		<meta http-equiv="Pragma" content="no-cache" />
		<title>Open Cap</title>
		<style>
			:root {
				color-scheme: light;
				font-family: Inter, "Segoe UI", sans-serif;
			}

			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				background: linear-gradient(180deg, #f6f8fc 0%, #eef3ff 100%);
				color: #111827;
			}

			main {
				width: min(440px, calc(100vw - 32px));
				padding: 32px 28px;
				border-radius: 24px;
				background: rgba(255, 255, 255, 0.92);
				box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
				text-align: center;
			}

			h1 {
				margin: 0 0 12px;
				font-size: 28px;
				line-height: 1.1;
			}

			p {
				margin: 0;
				font-size: 16px;
				line-height: 1.5;
				color: #4b5563;
			}

			.actions {
				margin-top: 24px;
				display: grid;
				gap: 12px;
			}

			a,
			button {
				width: 100%;
				border: 0;
				border-radius: 14px;
				padding: 14px 16px;
				font: inherit;
				font-weight: 600;
				cursor: pointer;
				text-decoration: none;
				box-sizing: border-box;
			}

			button {
				background: #2563eb;
				color: white;
			}

			a {
				background: #e5eefc;
				color: #1d4ed8;
			}

			#status {
				margin-top: 18px;
				font-size: 14px;
				color: #6b7280;
			}
		</style>
	</head>
	<body>
		<main>
			<h1>Opening Cap</h1>
			<p>If Cap does not open automatically, try the button below. Browser fallback will start in a moment.</p>
			<div class="actions">
				<button id="open-cap" type="button">Open Cap</button>
				<a id="browser-fallback" href="${fallbackUrl}">Use browser fallback</a>
			</div>
			<p id="status">Trying the desktop app first...</p>
		</main>
		<script>
			const { primaryUrl, fallbackUrl } = ${state};
			const status = document.getElementById("status");
			const openCapButton = document.getElementById("open-cap");
			const fallbackLink = document.getElementById("browser-fallback");
			let fallbackStarted = false;

			const startFallback = () => {
				if (fallbackStarted) return;
				fallbackStarted = true;
				status.textContent = "Switching to the browser fallback...";
				window.location.replace(fallbackUrl);
			};

			const openCap = () => {
				status.textContent = "Trying to open the Cap desktop app...";
				window.location.href = primaryUrl;
			};

			openCapButton.addEventListener("click", openCap);
			fallbackLink.addEventListener("click", () => {
				fallbackStarted = true;
			});

			openCap();
			window.setTimeout(startFallback, 1800);
		</script>
	</body>
</html>`;
}

app.get(
	"/request",
	zValidator(
		"query",
		z.object({
			port: z.string().optional(),
			platform: z
				.union([z.literal("web"), z.literal("desktop")])
				.default("web"),
			type: z
				.union([z.literal("session"), z.literal("api_key")])
				.default("session"),
		}),
	),
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

			const decodedToken = await decode({ token, secret });

			if (!decodedToken) return c.redirect(loginRedirectUrl);

			data = {
				type: "token",
				token,
				expires: String(decodedToken.exp),
			};
		} else {
			const id = crypto.randomUUID();
			await db().insert(authApiKeys).values({ id, userId: user.id });

			data = { type: "api_key", api_key: id };
		}

		const params = new URLSearchParams({ ...data, user_id: user.id });
		const localhostUrl = port
			? `http://127.0.0.1:${port}?${params}`
			: undefined;
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
