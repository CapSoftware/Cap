import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { users, videos } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { cookies } from "next/headers";
import { isUserOnProPlan } from "@cap/utils";
import { stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import { clientEnv } from "@cap/env";

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

  let isSubscribed = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus as string,
  });

  // Check for third-party Stripe subscription
  if (user.thirdPartyStripeSubscriptionId) {
    isSubscribed = true;
  }

  if (!isSubscribed && !user.stripeSubscriptionId && user.stripeCustomerId) {
    try {
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
      });
      const activeSubscription = subscriptions.data.find(
        (sub) => sub.status === "active"
      );
      if (activeSubscription) {
        isSubscribed = true;
        await db
          .update(users)
          .set({
            stripeSubscriptionStatus: activeSubscription.status,
            stripeSubscriptionId: activeSubscription.id,
          })
          .where(eq(users.id, user.id));
      }
    } catch (error) {
      console.error("[GET] Error fetching subscription from Stripe:", error);
    }
  }

  return new Response(
    JSON.stringify({
      upgraded: isSubscribed,
      stripeSubscriptionStatus: user.stripeSubscriptionStatus,
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
