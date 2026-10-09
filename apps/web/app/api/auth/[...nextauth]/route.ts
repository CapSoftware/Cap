import {
	authOptions,
	decodeSessionToken,
} from "@cap/database/auth/auth-options";
import { getWorkOS } from "@cap/database/auth/sso";
import {
	ssoIntentCookie,
	ssoLoginErrorPath,
	verifySsoLoginIntent,
} from "@cap/database/auth/sso-state";
import { serverEnv } from "@cap/env";
import { type NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { getToken } from "next-auth/jwt";
import { getSafeNextPath } from "@/app/(org)/safe-next";
import { isRateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function idpSignInConnection(request: NextRequest) {
	const query = request.nextUrl.searchParams;
	const code = query.get("code");
	if (
		request.method !== "GET" ||
		query.size !== 1 ||
		!code ||
		code.length > 2048 ||
		(await isRateLimited("rl_auth_sso_start", { headers: request.headers }))
	) {
		return null;
	}
	try {
		const clientId = serverEnv().WORKOS_CLIENT_ID;
		if (!clientId) return null;
		const { profile } = await getWorkOS().sso.getProfileAndToken({
			clientId,
			code,
		});
		return /^conn_[a-zA-Z0-9]{1,100}$/.test(profile.connectionId)
			? profile.connectionId
			: null;
	} catch {
		return null;
	}
}

async function readSignInBody(request: NextRequest) {
	if (request.method !== "POST") return null;
	try {
		const contentType = request.headers.get("content-type");
		if (contentType?.includes("application/json")) {
			const body: unknown = await request.clone().json();
			if (!body || typeof body !== "object") return null;
			const payload = body as Record<string, unknown>;
			return {
				json: payload.json === "true",
				callbackUrl:
					typeof payload.callbackUrl === "string" ? payload.callbackUrl : null,
			};
		}
		if (contentType?.includes("application/x-www-form-urlencoded")) {
			const body = new URLSearchParams(await request.clone().text());
			return {
				json: body.get("json") === "true",
				callbackUrl: body.get("callbackUrl"),
			};
		}
	} catch {
		return null;
	}
	return null;
}

async function handler(
	request: NextRequest,
	context: { params: Promise<{ nextauth: string[] }> },
) {
	const { nextauth } = await context.params;
	if (nextauth[1] !== "workos") {
		return NextAuth(request, context, authOptions());
	}
	const env = serverEnv();
	const cookie = ssoIntentCookie(new URL(env.WEB_URL).protocol === "https:");
	if (
		nextauth[0] === "callback" &&
		!request.nextUrl.searchParams.has("state")
	) {
		const connectionId = await idpSignInConnection(request);
		if (connectionId) {
			// An unsolicited code only selects the IdP; a fresh state/PKCE flow must authenticate the browser.
			const signInUrl = new URL("/login", env.WEB_URL);
			signInUrl.searchParams.set("connection_id", connectionId);
			const response = NextResponse.redirect(signInUrl, 303);
			response.headers.set("cache-control", "no-store");
			response.headers.set("referrer-policy", "no-referrer");
			response.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
			return response;
		}
	}
	const intent = verifySsoLoginIntent(
		request.cookies.get(cookie.name)?.value,
		env.NEXTAUTH_SECRET,
	);
	const token = await getToken({
		req: request,
		secret: env.NEXTAUTH_SECRET,
		cookieName: "next-auth.session-token",
		decode: decodeSessionToken,
	});
	const actorId = typeof token?.id === "string" ? token.id : null;
	if (
		!intent ||
		intent.actorId !== actorId ||
		(nextauth[0] === "signin" &&
			(request.nextUrl.searchParams.size !== 1 ||
				request.nextUrl.searchParams.get("connection") !== intent.connectionId))
	) {
		const body =
			nextauth[0] === "signin" ? await readSignInBody(request) : null;
		const returnTo = getSafeNextPath(
			intent?.returnTo ??
				body?.callbackUrl ??
				request.cookies.get("next-auth.callback-url")?.value,
			env.WEB_URL,
		);
		const errorUrl = new URL(
			ssoLoginErrorPath("SsoSessionExpired", returnTo),
			env.WEB_URL,
		);
		const response = body?.json
			? NextResponse.json({ url: errorUrl.toString() })
			: NextResponse.redirect(errorUrl, 303);
		response.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
		return response;
	}
	const response: Response = await NextAuth(
		request,
		context,
		authOptions({ intent, actorId }),
	);
	if (nextauth[0] === "callback") {
		response.headers.append(
			"set-cookie",
			`${cookie.name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookie.options.secure ? "; Secure" : ""}`,
		);
		const location = response.headers.get("location");
		if (location) {
			const redirectUrl = new URL(location, env.WEB_URL);
			if (
				redirectUrl.origin === new URL(env.WEB_URL).origin &&
				(redirectUrl.pathname === "/api/auth/error" ||
					redirectUrl.pathname === "/api/auth/signin" ||
					(redirectUrl.pathname === "/login" &&
						redirectUrl.searchParams.has("error")))
			) {
				const isMissingProfileAttributes =
					request.method === "GET" &&
					request.nextUrl.searchParams.getAll("error").length === 1 &&
					request.nextUrl.searchParams.getAll("error_description").length ===
						1 &&
					request.nextUrl.searchParams.get("error") === "server_error" &&
					request.nextUrl.searchParams.get("error_description") ===
						"The SAML Response did not contain expected attributes.";
				response.headers.set(
					"location",
					new URL(
						ssoLoginErrorPath(
							isMissingProfileAttributes
								? "SsoMissingProfileAttributes"
								: "SsoSignInFailed",
							intent.returnTo,
						),
						env.WEB_URL,
					).toString(),
				);
			}
		}
	}
	return response;
}

export { handler as GET, handler as POST };
