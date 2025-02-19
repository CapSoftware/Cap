import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { spaces, users } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { getProPlanBillingCycle, stripe } from "@cap/utils";
import { asc, desc, eq } from "drizzle-orm";
import { clientEnv } from "@cap/env";
import {
  generateCloudProStripeCheckoutSession,
  getIsUserPro,
} from "@/utils/instance/functions";

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

  console.log("[OPTIONS] Handling OPTIONS request");

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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, sentry-trace, baggage",
    },
  });
}

export async function POST(request: NextRequest) {
  console.log("[POST] Starting subscription request");

  const token = request.headers.get("authorization")?.split(" ")[1];
  if (token) {
    console.log("[POST] Setting auth cookie");
    cookies().set({
      name: "next-auth.session-token",
      value: token,
      path: "/",
      sameSite: "none",
      secure: true,
      httpOnly: true,
    });
  }

  const user = await getCurrentUser();
  const { priceId } = await request.json();
  const params = request.nextUrl.searchParams;
  const origin = params.get("origin") || null;
  const originalOrigin = request.nextUrl.origin;

  console.log("[POST] User:", user?.id);
  console.log("[POST] Price ID:", priceId);

  if (!priceId) {
    console.log("[POST] Error: No price ID provided");
    return Response.json(
      { error: true },
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }

  if (!user) {
    console.log("[POST] Error: No authenticated user");
    return Response.json(
      { error: true, auth: false },
      {
        status: 401,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }

  // get workspaces owned by the user, and assume that the oldest one is the personal workspace
  const personalWorkspace = await db.query.spaces.findFirst({
    where: eq(spaces.ownerId, user.id),
    orderBy: [asc(spaces.createdAt)],
    columns: {
      id: true,
      pro: true,
    },
  });

  if (!personalWorkspace) {
    console.log("[POST] Error: User has no personal workspace");
    return Response.json({ error: true }, { status: 400 });
  }

  if (personalWorkspace.pro) {
    console.log("[POST] Error: Workspace already on Pro plan");
    return Response.json(
      { error: true, subscription: true },
      {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin":
            origin && allowedOrigins.includes(origin)
              ? origin
              : allowedOrigins.includes(originalOrigin)
              ? originalOrigin
              : "null",
          "Access-Control-Allow-Credentials": "true",
        },
      }
    );
  }

  // get the price type based on the priceId
  const priceType = getProPlanBillingCycle(priceId);

  const checkoutSession = await generateCloudProStripeCheckoutSession({
    cloudWorkspaceId: personalWorkspace.id,
    cloudUserId: user.id,
    email: user.email,
    type: priceType,
  });

  if (!checkoutSession) {
    console.log("[POST] Error: Failed to create checkout session");
    return Response.json({ error: true }, { status: 400 });
  }

  if (checkoutSession.checkoutLink) {
    console.log("[POST] Checkout session created successfully");
    return Response.json(
      { url: checkoutSession.checkoutLink },
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
        },
      }
    );
  }

  console.log("[POST] Error: Failed to create checkout session");
  return Response.json(
    { error: true },
    {
      status: 400,
      headers: {
        "Access-Control-Allow-Origin":
          origin && allowedOrigins.includes(origin)
            ? origin
            : allowedOrigins.includes(originalOrigin)
            ? originalOrigin
            : "null",
        "Access-Control-Allow-Credentials": "true",
      },
    }
  );
}
