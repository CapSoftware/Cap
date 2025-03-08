import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { spaces } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";

const mainDomains = [
  "cap.so",
  "cap.link",
  "localhost",
  serverEnv.VERCEL_URL,
  serverEnv.VERCEL_BRANCH_URL,
  serverEnv.VERCEL_PROJECT_PRODUCTION_URL,
].filter(Boolean) as string[];

export async function middleware(request: NextRequest) {
  const hostname = request.headers.get("host");
  const path = request.nextUrl.pathname;

  if (!hostname) return NextResponse.next();

  // Skip for main domains
  if (mainDomains.some((d) => hostname.includes(d))) {
    return NextResponse.next();
  }

  // We're on a custom domain at this point
  // Only allow /s/ routes for custom domains
  if (!path.startsWith("/s/")) {
    const url = new URL(request.url);
    url.hostname = "cap.so";
    return NextResponse.redirect(url);
  }

  // Check if we have a cached verification
  const verifiedDomain = request.cookies.get("verified_domain");
  if (verifiedDomain?.value === hostname) {
    // Domain is verified from cache, handle CORS for API routes
    if (path.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        const response = new NextResponse(null, { status: 204 });
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS"
        );
        response.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        response.headers.set("Access-Control-Max-Age", "86400");
        return response;
      }

      const response = NextResponse.next();
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );
      return response;
    }
    return NextResponse.next();
  }

  try {
    // Query the space with this custom domain
    const [space] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.customDomain, hostname));

    if (!space || !space.domainVerified) {
      // If no verified custom domain found, redirect to main domain
      const url = new URL(request.url);
      url.hostname = "cap.so";
      return NextResponse.redirect(url);
    }

    // Domain is verified at this point, handle CORS for API routes
    if (path.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        const response = new NextResponse(null, { status: 204 });
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS"
        );
        response.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        response.headers.set("Access-Control-Max-Age", "86400");
        // Set verification cookie
        response.cookies.set("verified_domain", hostname, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600, // Cache for 1 hour
        });
        return response;
      }

      const response = NextResponse.next();
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );
      // Set verification cookie
      response.cookies.set("verified_domain", hostname, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 3600, // Cache for 1 hour
      });
      return response;
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
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
