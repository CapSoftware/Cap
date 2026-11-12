import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { db } from "@cap/database";
import {
	DUB_CLICK_ID_COOKIE,
	dubCookieDomain,
	parseDubClickId,
} from "@cap/database/referrals";
import { organizations } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { type NextRequest, NextResponse, userAgent } from "next/server";
import { agentMarkdownResponse } from "@/lib/agent-markdown";
import { INFRA_PATH_HEADER, isInfraPathname } from "@/lib/infra-routes";
import { getShareIframeRedirectUrl } from "@/lib/share-iframe-navigation";

const addHttps = (s?: string) => {
	if (!s) return s;
	return `https://${s}`;
};

const publicDir = resolve(process.cwd(), "public");

const isPublicAsset = (path: string) => {
	try {
		const file = resolve(publicDir, `.${decodeURIComponent(path)}`);
		if (!file.startsWith(`${publicDir}${sep}`)) return false;
		return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
	} catch {
		return false;
	}
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

const FRAME_PROTECTED_PATHS = [
	"/dashboard",
	"/onboarding",
	"/invite",
	"/cli/authorize",
	"/mcp/authorize",
	"/admin",
	"/signup",
	"/verify-otp",
	"/checkout",
];

const isFrameProtectedPath = (path: string) =>
	FRAME_PROTECTED_PATHS.some(
		(protectedPath) =>
			path === protectedPath || path.startsWith(`${protectedPath}/`),
	);

const setFrameHeaders = (response: NextResponse) => {
	response.headers.set("X-Frame-Options", "SAMEORIGIN");
	response.headers.set(
		"Content-Security-Policy",
		"frame-ancestors https://cap.so",
	);
	return response;
};

const REFERRAL_CLICK_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

// Partner links (go.cap.so) redirect here with ?dub_id=<click>. The Dub script
// stores it too, but ad blockers and no-JS visits skip the script, and without
// the cookie the sign-up and purchase are never credited to the partner.
const rememberReferralClick = (
	request: NextRequest,
	response: NextResponse,
) => {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true" || request.method !== "GET") {
		return response;
	}
	const url = request.nextUrl;
	const clickId = parseDubClickId(url.searchParams.get(DUB_CLICK_ID_COOKIE));
	if (!clickId) return response;

	response.cookies.set(DUB_CLICK_ID_COOKIE, clickId, {
		domain: dubCookieDomain(url.hostname),
		path: "/",
		sameSite: "lax",
		secure: url.protocol === "https:",
		maxAge: REFERRAL_CLICK_MAX_AGE_SECONDS,
	});
	return response;
};

const DUB_PROXY_PREFIX = "/_proxy/dub/";

// Developer video pages are embedded on other sites, so they never set a
// cookie, not even the referral click.
const DEVELOPER_VIDEO_PREFIX = "/dev/";

const dubProxyTarget = (path: string) => {
	if (path === `${DUB_PROXY_PREFIX}script.js`) {
		return "https://www.dubcdn.com/analytics/script.js";
	}
	const track = /^\/_proxy\/dub\/track\/([a-z-]{1,32})$/.exec(path);
	return track ? `https://api.dub.co/track/${track[1]}` : null;
};

// Serves the Dub script and its click tracking from cap.so so ad blockers
// don't drop them. Visitor cookies (including the Cap session) are stripped:
// Dub needs none of them.
const proxyDub = (request: NextRequest) => {
	const target =
		buildEnv.NEXT_PUBLIC_IS_CAP === "true"
			? dubProxyTarget(request.nextUrl.pathname)
			: null;
	if (!target) return new NextResponse(null, { status: 404 });

	const headers = new Headers(request.headers);
	headers.delete("cookie");
	headers.delete("authorization");
	return NextResponse.rewrite(new URL(target), { request: { headers } });
};

// Server components cannot read the address they render for, and the Infra
// console needs it to send a signed-out visitor back to the page they asked
// for. The value is always set here, so one sent by a client is replaced.
const serve = (request: NextRequest) => {
	const { pathname, search } = request.nextUrl;
	if (!isInfraPathname(pathname)) return NextResponse.next();
	const headers = new Headers(request.headers);
	headers.set(INFRA_PATH_HEADER, `${pathname}${search}`);
	return NextResponse.next({ request: { headers } });
};

export async function proxy(request: NextRequest) {
	const path = new URL(request.url).pathname;

	if (path.startsWith(DUB_PROXY_PREFIX)) return proxyDub(request);

	if (path.startsWith("/login")) {
		return rememberReferralClick(request, setFrameHeaders(NextResponse.next()));
	}

	const response = await route(request);
	if (path.startsWith(DEVELOPER_VIDEO_PREFIX)) return response;
	return rememberReferralClick(
		request,
		isFrameProtectedPath(path) ? setFrameHeaders(response) : response,
	);
}

async function route(request: NextRequest) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/" && request.cookies.has("next-auth.session-token")) {
		return NextResponse.redirect(new URL("/dashboard/caps", url.origin));
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
		return response;
	}

	const hostname = url.hostname;

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		// Files under public/ have no route of their own, so without this every
		// <img src="/logos/..."> on a self-hosted instance redirects to /login.
		if (
			!(
				isPublicAsset(path) ||
				path.startsWith("/s/") ||
				path.startsWith("/c/") ||
				path.startsWith("/cli/") ||
				path.startsWith("/mcp/") ||
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
				path.startsWith(DEVELOPER_VIDEO_PREFIX) ||
				path.startsWith("/.well-known/workflow/") ||
				path.startsWith("/.well-known/oauth-") ||
				path.startsWith("/.well-known/mcp") ||
				path === "/.well-known/api-catalog" ||
				path === "/openapi.json"
			) &&
			process.env.NODE_ENV !== "development"
		)
			return NextResponse.redirect(new URL("/login", url.origin));
		else return serve(request);
	}

	if (mainOrigins.some((d) => url.origin.startsWith(d))) {
		const markdown = await agentMarkdownResponse(request, { isPublicAsset });
		if (!markdown) return serve(request);
		return new NextResponse(markdown.body, {
			status: markdown.status,
			headers: markdown.headers,
		});
	}

	const webUrl = new URL(serverEnv().WEB_URL).hostname;

	try {
		if (!(path.startsWith("/s/") || path.startsWith("/c/"))) {
			const url = new URL(request.url);
			url.hostname = webUrl;
			return NextResponse.redirect(url);
		}

		const verifiedDomain = request.cookies.get("verified_domain");
		if (verifiedDomain?.value === hostname) return NextResponse.next();

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

		return response;
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
