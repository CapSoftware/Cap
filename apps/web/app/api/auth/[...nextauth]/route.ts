import {
	authOptions,
	decodeSessionToken,
} from "@cap/database/auth/auth-options";
import { normalizeSignInEmail } from "@cap/database/auth/domain-utils";
import {
	consumeGoogleOneTapNonce,
	GOOGLE_ONE_TAP_PROVIDER_ID,
	googleOneTapNonceCookieForWebUrl,
	googleOneTapNonceSetCookie,
	readCookie,
} from "@cap/database/auth/google-one-tap";
import { getWorkOS } from "@cap/database/auth/sso";
import {
	ssoIntentCookie,
	ssoLoginErrorPath,
	verifySsoLoginIntent,
} from "@cap/database/auth/sso-state";
import { serverEnv } from "@cap/env";
import { NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { getToken } from "next-auth/jwt";
import { getSafeNextPath } from "@/app/(org)/safe-next";
import {
	isEmailCodeSendLimited,
	isEmailCodeVerifyLimited,
} from "@/lib/email-code-rate-limit";
import { logNewAccountAddress } from "@/lib/ip-reputation";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { shouldRefuseTorExit } from "@/lib/tor-exit-gate";

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
				email: typeof payload.email === "string" ? payload.email : null,
			};
		}
		if (contentType?.includes("application/x-www-form-urlencoded")) {
			const body = new URLSearchParams(await request.clone().text());
			return {
				json: body.get("json") === "true",
				callbackUrl: body.get("callbackUrl"),
				email: body.get("email"),
			};
		}
	} catch {
		return null;
	}
	return null;
}

async function readOneTapCredential(
	request: NextRequest,
): Promise<string | null | "duplicate"> {
	if (request.method !== "POST") return null;
	try {
		const contentType = request.headers.get("content-type");
		if (contentType?.includes("application/x-www-form-urlencoded")) {
			const values = new URLSearchParams(await request.clone().text()).getAll(
				"credential",
			);
			if (values.length > 1) return "duplicate";
			return values[0] ?? null;
		}
		if (contentType?.includes("application/json")) {
			const body: unknown = await request.clone().json();
			const credential =
				body && typeof body === "object"
					? (body as Record<string, unknown>).credential
					: null;
			return typeof credential === "string" ? credential : null;
		}
	} catch {
		return null;
	}
	return null;
}

function authErrorUrl(error: string) {
	const url = new URL("/api/auth/error", serverEnv().WEB_URL);
	url.searchParams.set("error", error);
	return url.toString();
}

async function emailCodeLimitResponse(
	request: NextRequest,
	nextauth: string[],
) {
	if (nextauth[1] !== "email") return null;
	if (nextauth[0] === "signin" && request.method === "POST") {
		const body = await readSignInBody(request);
		const email = normalizeSignInEmail(body?.email);
		if (!email || !(await isEmailCodeSendLimited(email, request.headers))) {
			return null;
		}
		const url = authErrorUrl("EmailSignin");
		return body?.json
			? NextResponse.json({ url }, { status: 429 })
			: NextResponse.redirect(url, 302);
	}
	if (nextauth[0] === "callback") {
		const query = request.nextUrl.searchParams;
		const rawEmail = query.get("email");
		const email = normalizeSignInEmail(rawEmail);
		if (rawEmail && !email) {
			return NextResponse.redirect(authErrorUrl("Verification"), 302);
		}
		if (
			!email ||
			!query.get("token") ||
			!(await isEmailCodeVerifyLimited(email, request.headers))
		) {
			return null;
		}
		return NextResponse.redirect(authErrorUrl("Verification"), 302);
	}
	return null;
}

async function torExitResponse(request: NextRequest, nextauth: string[]) {
	if (nextauth[0] !== "signin" && nextauth[0] !== "callback") return null;
	if (!nextauth[1]) return null;
	if (!(await shouldRefuseTorExit("web-sign-in", request.headers))) return null;
	const url = new URL("/login", serverEnv().WEB_URL);
	url.searchParams.set("error", "SignupBlocked");
	const body = await readSignInBody(request);
	return body?.json
		? NextResponse.json({ url: url.toString() }, { status: 403 })
		: NextResponse.redirect(url, 302);
}

function signInFlow(request: NextRequest) {
	const callbackUrl = request.cookies.get("next-auth.callback-url")?.value;
	if (!callbackUrl) return "web";
	try {
		const { pathname } = new URL(callbackUrl, serverEnv().WEB_URL);
		if (pathname.startsWith("/api/desktop/")) return "desktop";
		if (pathname.startsWith("/api/mobile/")) return "mobile";
	} catch {}
	return "web";
}

function newAccountHooks(request: NextRequest, nextauth: string[]) {
	return {
		onUserCreated: () => {
			logNewAccountAddress("web-sign-in", request.headers, {
				provider: nextauth[1],
				flow: signInFlow(request),
			});
		},
	};
}

function withSignInEmailIdentifier(request: NextRequest, nextauth: string[]) {
	if (nextauth[0] !== "callback" || nextauth[1] !== "email") return request;
	const email = request.nextUrl.searchParams.get("email");
	const identifier = normalizeSignInEmail(email);
	if (!identifier || identifier === email) return request;
	const url = request.nextUrl.clone();
	url.searchParams.set("email", identifier);
	return new NextRequest(url, request);
}

async function handler(
	request: NextRequest,
	context: { params: Promise<{ nextauth: string[] }> },
) {
	const { nextauth } = await context.params;
	const refusedResponse = await torExitResponse(request, nextauth);
	if (refusedResponse) return refusedResponse;
	const limitedResponse = await emailCodeLimitResponse(request, nextauth);
	if (limitedResponse) return limitedResponse;
	if (
		nextauth[0] === "callback" &&
		nextauth[1] === "passkey" &&
		(await isRateLimited(RATE_LIMIT_IDS.AUTH_PASSKEY, {
			headers: request.headers,
		}))
	) {
		return NextResponse.json(
			{ url: authErrorUrl("CredentialsSignin") },
			{ status: 429 },
		);
	}
	if (
		nextauth[1] === GOOGLE_ONE_TAP_PROVIDER_ID &&
		nextauth[0] === "callback"
	) {
		if (
			await isRateLimited(RATE_LIMIT_IDS.AUTH_GOOGLE_ONE_TAP, {
				headers: request.headers,
			})
		) {
			return NextResponse.json(
				{ url: authErrorUrl("CredentialsSignin") },
				{ status: 429 },
			);
		}
		const webUrl = serverEnv().WEB_URL;
		const nonces = readCookie(
			request.headers.get("cookie"),
			googleOneTapNonceCookieForWebUrl(webUrl).name,
		);
		const credential = await readOneTapCredential(request);
		if (credential === "duplicate") {
			return NextResponse.json(
				{ url: authErrorUrl("CredentialsSignin") },
				{ status: 400 },
			);
		}
		const response: Response = await NextAuth(
			request,
			context,
			authOptions(undefined, newAccountHooks(request, nextauth)),
		);
		response.headers.append(
			"set-cookie",
			googleOneTapNonceSetCookie(
				webUrl,
				consumeGoogleOneTapNonce(nonces, credential),
			),
		);
		return response;
	}
	if (nextauth[1] !== "workos") {
		return NextAuth(
			withSignInEmailIdentifier(request, nextauth),
			context,
			authOptions(undefined, newAccountHooks(request, nextauth)),
		);
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
		authOptions({ intent, actorId }, newAccountHooks(request, nextauth)),
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
