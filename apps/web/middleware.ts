import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { spaces } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { buildEnv, serverEnv } from "@cap/env";
import { notFound } from "next/navigation";

const mainOrigins = [
  "https://cap.so",
  "https://cap.link",
  "http://localhost",
  serverEnv().WEB_URL,
  serverEnv().VERCEL_URL,
  serverEnv().VERCEL_BRANCH_URL,
  serverEnv().VERCEL_PROJECT_PRODUCTION_URL,
].filter(Boolean) as string[];

export async function middleware(request: NextRequest) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const path = url.pathname;

  const webUrl = new URL(serverEnv().WEB_URL).hostname;

  if (
    buildEnv.NEXT_PUBLIC_IS_CAP !== "true" ||
    mainOrigins.some((d) => url.origin === d)
  ) {
    // We just let the request go through for main domains, page-level logic will handle redirects
    return NextResponse.next();
  }

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
    const [space] = await db()
      .select()
      .from(spaces)
      .where(eq(spaces.customDomain, hostname));

    if (!space || !space.domainVerified) {
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
