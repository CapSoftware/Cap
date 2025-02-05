import { type NextRequest } from "next/server";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { isUserOnProPlan, stripe } from "@cap/utils";
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
  let customerId = user?.stripeCustomerId;
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

  if (
    isUserOnProPlan({
      subscriptionStatus: user.stripeSubscriptionStatus as string,
    })
  ) {
    console.log("[POST] Error: User already on Pro plan");
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

  if (!user.stripeCustomerId) {
    console.log("[POST] Creating new Stripe customer");
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: {
        userId: user.id,
      },
    });

    await db
      .update(users)
      .set({
        stripeCustomerId: customer.id,
      })
      .where(eq(users.id, user.id));

    customerId = customer.id;
    console.log("[POST] Created Stripe customer:", customerId);
  }

  console.log("[POST] Creating checkout session");
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId as string,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: "subscription",
    success_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/dashboard/caps?upgrade=true`,
    cancel_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/pricing`,
    allow_promotion_codes: true,
  });

  if (checkoutSession.url) {
    console.log("[POST] Checkout session created successfully");
    return Response.json(
      { url: checkoutSession.url },
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
