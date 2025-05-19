import { db } from "@cap/database";
import { organizations } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { buildEnv, serverEnv } from "@cap/env";
import { notFound } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";

const addHttps = (s?: string) => {
  if (!s) return s;
  return `https://${s}`;
};

const mainOrigins = [
  "https://cap.so",
  "https://cap.link",
  "http://localhost",
  serverEnv().WEB_URL,
  addHttps(serverEnv().VERCEL_URL),
  addHttps(serverEnv().VERCEL_BRANCH_URL),
  addHttps(serverEnv().VERCEL_PROJECT_PRODUCTION_URL),
].filter(Boolean) as string[];

export async function middleware(request: NextRequest) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const path = url.pathname;

  if((buildEnv.NEXT_PUBLIC_IS_CAP !== "true" &&
    !(path.startsWith("/s/") ||
      path.startsWith("/dashboard") ||
      path.startsWith("/onboarding") ||
      path.startsWith("/api") || 
      path.startsWith("/login") || 
      path.startsWith("/invite") ||
      path.startsWith("/self-hosting") ||
      path.startsWith("/terms")))) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  if (
    mainOrigins.some((d) => url.origin.startsWith(d))
  ) {
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
      console.log({ url });
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
    const referrer = request.headers.get('referer') || '';
    const userAgent = request.headers.get('user-agent') || '';

    // Add custom headers to check in generateMetadata
    response.headers.set('x-pathname', pathname);
    response.headers.set('x-referrer', referrer);
    response.headers.set('x-user-agent', userAgent);

    return response;
  } catch (error) {
    console.error("Error in middleware:", error);
    return notFound();
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, robots.txt, sitemap.xml (static files)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};