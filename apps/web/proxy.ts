import {
	normalizeAnalyticsIdentifier,
	PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE,
} from "@cap/analytics";
import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { type NextRequest, NextResponse, userAgent } from "next/server";
import {
	createProductAnalyticsAnonymousId,
	createProductAnalyticsBrowserToken,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS,
	readProductAnalyticsBrowserTokenClaims,
} from "@/lib/analytics/browser-token";
import { getShareIframeRedirectUrl } from "@/lib/share-iframe-navigation";

const addHttps = (s?: string) => {
	if (!s) return s;
	return `https://${s}`;
};

const mainOrigins = [
	"https://cap.so",
	"https://cap.link",
	"http://localhost",
	serverEnv().WEB_URL,
	addHttps(serverEnv().VERCEL_URL_HOST),
	addHttps(serverEnv().VERCEL_BRANCH_URL_HOST),
	addHttps(serverEnv().VERCEL_PROJECT_PRODUCTION_URL_HOST),
].filter(Boolean) as string[];

const nextWithAnalyticsToken = (
	request: NextRequest,
	response = NextResponse.next(),
) => {
	const secret = serverEnv().NEXTAUTH_SECRET;
	const token = request.cookies.get(
		PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE,
	)?.value;
	const claims = readProductAnalyticsBrowserTokenClaims(token, secret);
	const existingAnonymousId = normalizeAnalyticsIdentifier(
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
	const anonymousId =
		existingAnonymousId ??
		claims?.anonymousId ??
		createProductAnalyticsAnonymousId();
	if (!claims || claims.anonymousId !== anonymousId) {
		response.cookies.set(
			PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE,
			createProductAnalyticsBrowserToken(secret, anonymousId),
			{
				httpOnly: true,
				maxAge: PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS,
				path: "/",
				sameSite: "strict",
				secure: process.env.NODE_ENV === "production",
			},
		);
	}
	if (
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value !==
		anonymousId
	) {
		response.cookies.set(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE, anonymousId, {
			maxAge: 365 * 24 * 60 * 60,
			path: "/",
			sameSite: "lax",
			secure: process.env.NODE_ENV === "production",
		});
	}
	return response;
};

export async function proxy(request: NextRequest) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/" && request.cookies.has("next-auth.session-token")) {
		return NextResponse.redirect(new URL("/dashboard/caps", url.origin));
	}

	if (path.startsWith("/login")) {
		const response = nextWithAnalyticsToken(request);
		response.headers.set("X-Frame-Options", "SAMEORIGIN");
		response.headers.set(
			"Content-Security-Policy",
			"frame-ancestors https://cap.so",
		);
		return response;
	}

	const shareIframeRedirectUrl = getShareIframeRedirectUrl({
		method: request.method,
		requestUrl: request.url,
		fetchDestination: request.headers.get("sec-fetch-dest"),
	});
	if (shareIframeRedirectUrl) {
		const response = NextResponse.redirect(shareIframeRedirectUrl);
		response.headers.set("Cache-Control", "private, no-store");
		response.headers.set("Vary", "Sec-Fetch-Dest");
		return nextWithAnalyticsToken(request, response);
	}

	const hostname = url.hostname;

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		if (
			!(
				path.startsWith("/s/") ||
				path.startsWith("/c/") ||
				path.startsWith("/cli/") ||
				path.startsWith("/middleware") ||
				path.startsWith("/dashboard") ||
				path.startsWith("/onboarding") ||
				path.startsWith("/api") ||
				path.startsWith("/login") ||
				path.startsWith("/signup") ||
				path.startsWith("/invite") ||
				path.startsWith("/self-hosting") ||
				path.startsWith("/download") ||
				path.startsWith("/terms") ||
				path.startsWith("/verify-otp") ||
				path.startsWith("/embed/") ||
				path.startsWith("/.well-known/workflow/")
			) &&
			process.env.NODE_ENV !== "development"
		)
			return NextResponse.redirect(new URL("/login", url.origin));
		else return nextWithAnalyticsToken(request);
	}

	if (mainOrigins.some((d) => url.origin.startsWith(d))) {
		return nextWithAnalyticsToken(request);
	}

	const webUrl = new URL(serverEnv().WEB_URL).hostname;

	try {
		if (!(path.startsWith("/s/") || path.startsWith("/c/"))) {
			const url = new URL(request.url);
			url.hostname = webUrl;
			return NextResponse.redirect(url);
		}

		const verifiedDomain = request.cookies.get("verified_domain");
		if (verifiedDomain?.value === hostname)
			return nextWithAnalyticsToken(request);

		const [organization] = await db()
			.select()
			.from(organizations)
			.where(eq(organizations.customDomain, hostname));

		if (!organization || !organization.domainVerified) {
			const url = new URL(request.url);
			url.hostname = webUrl;
			return NextResponse.redirect(url);
		}

		const response = NextResponse.next();
		response.cookies.set("verified_domain", hostname, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			maxAge: 3600,
		});

		const { pathname } = request.nextUrl;
		const referrer = request.headers.get("referer") || "";

		const ua = userAgent(request);

		response.headers.set("x-pathname", pathname);
		response.headers.set("x-referrer", referrer);
		response.headers.set("x-user-agent", JSON.stringify(ua));

		return nextWithAnalyticsToken(request, response);
	} catch (error) {
		console.error("Error in proxy:", error);
		return notFound();
	}
}

export const config = {
	matcher: [
		"/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
	],
};
