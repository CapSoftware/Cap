import { type NextRequest } from "next/server";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { clientEnv } from "@cap/env";
import crypto from "crypto";
import { getIsUserPro } from "@/utils/instance/functions";

const allowedOrigins = [
  clientEnv.NEXT_PUBLIC_WEB_URL,
  "http://localhost:3001",
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

  if (!user) {
    return Response.json({ error: true }, { status: 401 });
  }

  const isPro = await getIsUserPro({ userId: user.id });

  let intercomHash = "";
  if (process.env.INTERCOM_SECRET) {
    intercomHash = crypto
      .createHmac("sha256", process.env.INTERCOM_SECRET)
      .update(user?.id ?? "")
      .digest("hex");
  }

  return new Response(
    JSON.stringify({
      upgraded: isPro,
      stripeSubscriptionStatus: "active",
      // TODO: Legacy: stripeSubscriptionStatus: user.stripeSubscriptionStatus,
      intercomHash: intercomHash,
    }),
    {
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
    }
  );
}
