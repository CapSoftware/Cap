import { stripe } from "@cap/utils";
import { NextRequest } from "next/server";
import { buildEnv, serverEnv } from "@cap/env";
import { PostHog } from "posthog-node";

export async function POST(request: NextRequest) {
  console.log("Starting guest checkout process");
  const { priceId, quantity } = await request.json();

  console.log("Received guest checkout request:", { priceId, quantity });

  if (!priceId) {
    console.error("Missing required priceId");
    return Response.json({ error: "priceId is required" }, { status: 400 });
  }

  try {
    console.log("Creating guest checkout session");
    const checkoutSession = await stripe().checkout.sessions.create({
      line_items: [{ price: priceId, quantity: quantity || 1 }],
      mode: "subscription",
      success_url: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true&guest=true`,
      cancel_url: `${serverEnv().WEB_URL}/pricing`,
      allow_promotion_codes: true,
      metadata: { 
        platform: "web", 
        guestCheckout: "true",
      },
    });

    if (checkoutSession.url) {
      console.log("Successfully created guest checkout session");

      try {
        const ph = new PostHog(buildEnv.NEXT_PUBLIC_POSTHOG_KEY || "", {
          host: buildEnv.NEXT_PUBLIC_POSTHOG_HOST || "",
        });

        ph.capture({
          distinctId: "guest-" + checkoutSession.id,
          event: "guest_checkout_started",
          properties: {
            price_id: priceId,
            quantity: quantity || 1,
            platform: "web",
            session_id: checkoutSession.id,
          },
        });

        await ph.shutdown();
      } catch (e) {
        console.error("Failed to capture guest_checkout_started in PostHog", e);
      }

      return Response.json({ url: checkoutSession.url }, { status: 200 });
    }

    console.error("Checkout session created but no URL returned");
    return Response.json({ error: "Failed to create checkout session" }, { status: 400 });
  } catch (error) {
    console.error("Error creating guest checkout session:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}