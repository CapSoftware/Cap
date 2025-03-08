import { clientEnv, serverEnv } from "@cap/env";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { isUserOnProPlan, stripe } from "@cap/utils";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import * as crypto from "node:crypto";
import { withAuth } from "../utils";

export const app = new Hono().use(withAuth);

app.post(
  "/feedback",
  zValidator("form", z.object({ feedback: z.string() })),
  async (c) => {
    const { feedback } = c.req.valid("form");

    try {
      // Send feedback to Discord channel
      const discordWebhookUrl = serverEnv.DISCORD_FEEDBACK_WEBHOOK_URL;
      if (!discordWebhookUrl)
        throw new Error("Discord webhook URL is not configured");

      const response = await fetch(discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `New feedback from ${c.get("user").email}:\n${feedback}`,
        }),
      });

      if (!response.ok)
        throw new Error(
          `Failed to send feedback to Discord: ${response.statusText}`
        );

      return c.json({
        success: true,
        message: "Feedback submitted successfully",
      });
    } catch (error) {
      return c.json({ error: "Failed to submit feedback" }, { status: 500 });
    }
  }
);

app.get("/plan", async (c) => {
  const user = c.get("user");

  let isSubscribed = isUserOnProPlan({
    subscriptionStatus: user.stripeSubscriptionStatus,
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

  let intercomHash = "";
  if (serverEnv.INTERCOM_SECRET) {
    intercomHash = crypto
      .createHmac("sha256", serverEnv.INTERCOM_SECRET)
      .update(user?.id ?? "")
      .digest("hex");
  }

  return c.json({
    upgraded: isSubscribed,
    stripeSubscriptionStatus: user.stripeSubscriptionStatus,
    intercomHash: intercomHash,
  });
});

app.post(
  "/subscribe",
  zValidator("json", z.object({ priceId: z.string() })),
  async (c) => {
    const { priceId } = c.req.valid("json");
    const user = c.get("user");

    if (
      isUserOnProPlan({ subscriptionStatus: user.stripeSubscriptionStatus })
    ) {
      console.log("[POST] Error: User already on Pro plan");
      return c.json({ error: true, subscription: true }, { status: 400 });
    }

    let customerId = user.stripeCustomerId;

    if (user.stripeCustomerId === null) {
      console.log("[POST] Creating new Stripe customer");
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      });

      await db
        .update(users)
        .set({ stripeCustomerId: customer.id })
        .where(eq(users.id, user.id));

      customerId = customer.id;
      console.log("[POST] Created Stripe customer:", customerId);
    }

    console.log("[POST] Creating checkout session");
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId as string,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/dashboard/caps?upgrade=true`,
      cancel_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/pricing`,
      allow_promotion_codes: true,
    });

    if (checkoutSession.url) {
      console.log("[POST] Checkout session created successfully");
      return c.json({ url: checkoutSession.url });
    }

    console.log("[POST] Error: Failed to create checkout session");
    return c.json({ error: true }, { status: 400 });
  }
);
