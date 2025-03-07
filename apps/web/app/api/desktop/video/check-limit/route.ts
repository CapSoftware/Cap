import type { NextRequest } from "next/server";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { count, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { isUserOnProPlan } from "@cap/utils";
import { clientEnv } from "@cap/env";

const allowedOrigins = [
  clientEnv.NEXT_PUBLIC_WEB_URL,
  "http://localhost:3001",
  "http://localhost:3000",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export async function OPTIONS(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
}

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.split(" ")[1];
  if (token) {
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  }

  const params = req.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = req.nextUrl.origin;
  
  const user = await getCurrentUser();
  console.log("/api/desktop/video/check-limit user", user);

  if (!user) {
    console.log("User not authenticated, returning 401");
    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
      },
    });
  }

  // Check if free user has reached the limit of 2 shareable links
  const isProUser = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus as string,
  });

  if (!isProUser) {
    const videoCount = await db
      .select({ count: count() })
      .from(videos)
      .where(eq(videos.ownerId, user.id));

    if (videoCount[0] && videoCount[0].count >= 2) {
      return new Response(JSON.stringify({ error: "shareable_link_limit_reached" }), {
        status: 403,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
        },
      });
    }
  }

  // User is either pro or has not reached the limit
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin":
        origin && allowedOrigins.includes(origin)
          ? origin
          : allowedOrigins.includes(originalOrigin)
          ? originalOrigin
          : "null",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, sentry-trace, baggage",
    },
  });
} 