import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { spaces } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { serverEnv } from "@cap/env";
import { getToken } from "next-auth/jwt";

const ALLOWED_DOMAINS = [
  "opavc.com",
  "opavc.link",
  "localhost",
  "localhost:3000",
  "127.0.0.1",
  "127.0.0.1:3000",
];

const mainDomains = [
  "opavc.com",
  "opavc.link",
  "localhost",
  serverEnv.VERCEL_URL,
  serverEnv.VERCEL_BRANCH_URL,
];

export async function middleware(request: NextRequest) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const path = url.pathname;

  if (!hostname) return NextResponse.next();

  if (mainDomains.some((d) => hostname.includes(d))) {
    // We just let the request go through for main domains, page-level logic will handle redirects
    return NextResponse.next();
  }

  if (url.hostname === "www.opavc.com") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  if (url.hostname === "www.opavc.link") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  if (url.hostname === "cap.so") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  if (url.hostname === "cap.link") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  if (url.hostname === "www.cap.so") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  if (url.hostname === "www.cap.link") {
    url.hostname = "opavc.com";
    return NextResponse.redirect(url);
  }

  // We're on a custom domain at this point
  // Only allow /s/ routes for custom domains
  if (!path.startsWith("/s/")) {
    const url = new URL(request.url);
    url.hostname = "opavc.com";
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
      url.hostname = "opavc.com";
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
