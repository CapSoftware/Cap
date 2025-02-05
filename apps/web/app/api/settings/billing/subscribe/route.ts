import { isUserOnProPlan, stripe } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { clientEnv } from "@cap/env";

export async function POST(request: NextRequest) {
  console.log("Starting subscription process");
  const user = await getCurrentUser();
  let customerId = user?.stripeCustomerId;
  const { priceId, quantity } = await request.json();

  console.log("Received request with priceId:", priceId);
  console.log("Current user:", user?.id);

  if (!priceId) {
    console.error("Price ID not found");
    return Response.json({ error: true }, { status: 400 });
  }

  if (!user) {
    console.error("User not found");
    return Response.json({ error: true, auth: false }, { status: 401 });
  }

  if (
    isUserOnProPlan({
      subscriptionStatus: user.stripeSubscriptionStatus as string,
    })
  ) {
    console.error("User already has pro plan");
    return Response.json({ error: true, subscription: true }, { status: 400 });
  }

  try {
    if (!user.stripeCustomerId) {
      console.log("Creating new Stripe customer for user:", user.id);
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id,
        },
      });

      console.log("Created Stripe customer:", customer.id);

      await db
        .update(users)
        .set({
          stripeCustomerId: customer.id,
        })
        .where(eq(users.id, user.id));

      console.log("Updated user with Stripe customer ID");
      customerId = customer.id;
    }

    console.log("Creating checkout session for customer:", customerId);
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId as string,
      line_items: [{ price: priceId, quantity: quantity }],
      mode: "subscription",
      success_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/dashboard/caps?upgrade=true`,
      cancel_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/pricing`,
      allow_promotion_codes: true,
    });

    if (checkoutSession.url) {
      console.log("Successfully created checkout session");
      return Response.json({ url: checkoutSession.url }, { status: 200 });
    }

    console.error("Checkout session created but no URL returned");
    return Response.json({ error: true }, { status: 400 });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return Response.json({ error: true }, { status: 500 });
  }
}
