import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { type NextRequest, NextResponse, userAgent } from "next/server";

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

export async function middleware(request: NextRequest) {
	const url = new URL(request.url);
	const path = url.pathname;

	// Add anti-clickjacking headers for /login
	if (path.startsWith("/login")) {
		const response = NextResponse.next();
		response.headers.set("X-Frame-Options", "SAMEORIGIN");
		response.headers.set(
			"Content-Security-Policy",
			"frame-ancestors https://cap.so",
		);
		return response;
	}

	const hostname = url.hostname;

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		if (
			!(
				path.startsWith("/s/") ||
				path.startsWith("/embed/") ||
				path.startsWith("/middleware") ||
				path.startsWith("/dashboard") ||
				path.startsWith("/onboarding") ||
				path.startsWith("/api") ||
				path.startsWith("/login") ||
				path.startsWith("/signup") ||
				path.startsWith("/invite") ||
				path.startsWith("/self-hosting") ||
				path.startsWith("/terms") ||
				path.startsWith("/verify-otp")
			) &&
			process.env.NODE_ENV !== "development"
		)
			return NextResponse.redirect(new URL("/login", url.origin));
		else return NextResponse.next();
	}

	if (mainOrigins.some((d) => url.origin.startsWith(d))) {
		// We just let the request go through for main domains, page-level logic will handle redirects
		return NextResponse.next();
	}

	const webUrl = new URL(serverEnv().WEB_URL).hostname;

	try {
		// We're on a custom domain at this point
		// Only allow /s/ routes for custom domains
		if (!path.startsWith("/s/")) {
			const url = new URL(request.url);
			url.hostname = webUrl;
			return NextResponse.redirect(url);
		}

		// Check if we have a cached verification
		const verifiedDomain = request.cookies.get("verified_domain");
		if (verifiedDomain?.value === hostname) return NextResponse.next();

		// Query the space with this custom domain
		const [organization] = await db()
			.select()
			.from(organizations)
			.where(eq(organizations.customDomain, hostname));

		if (!organization || !organization.domainVerified) {
			// If no verified custom domain found, redirect to main domain
			const url = new URL(request.url);
			url.hostname = webUrl;
			return NextResponse.redirect(url);
		}

		// Set verification cookie for non-API routes too
		const response = NextResponse.next();
		response.cookies.set("verified_domain", hostname, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "strict",
			maxAge: 3600, // Cache for 1 hour
		});

		// Get the pathname and referrer
		const { pathname } = request.nextUrl;
		const referrer = request.headers.get("referer") || "";

		// Parse user agent with the userAgent utility
		const ua = userAgent(request);

		// Add custom headers to check in generateMetadata
		response.headers.set("x-pathname", pathname);
		response.headers.set("x-referrer", referrer);
		response.headers.set("x-user-agent", JSON.stringify(ua));

		return response;
	} catch (error) {
		console.error("Error in middleware:", error);
		return notFound();
	}
}

export const config = {
	runtime: "nodejs",
	matcher: [
		/*
		 * Match all request paths except for the ones starting with:
		 * - api (API routes)
		 * - _next/static (static files)
		 * - _next/image (image optimization files)
		 * - favicon.ico, robots.txt, sitemap.xml (static files)
		 */
		"/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
	],
};
