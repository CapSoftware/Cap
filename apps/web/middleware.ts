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

  if (
    buildEnv.NEXT_PUBLIC_IS_CAP !== "true" ||
    mainOrigins.some((d) => url.origin === d)
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
    return response;
  } catch (error) {
    console.error("Error in middleware:", error);
    return notFound();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
