import { stripe } from "@cap/utils";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import Stripe from "stripe";

const relevantEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

export const POST = async (req: Request) => {
  const buf = await req.text();
  const sig = req.headers.get("Stripe-Signature") as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event: Stripe.Event;
  try {
    if (!sig || !webhookSecret) return;
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err: any) {
    console.log(`❌ Error message: ${err.message}`);
    return new Response(`Webhook Error: ${err.message}`, {
      status: 400,
    });
  }
  if (relevantEvents.has(event.type)) {
    try {
      if (event.type === "checkout.session.completed") {
        const customer = await stripe.customers.retrieve(
          event.data.object.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          return new Response("No user found", {
            status: 400,
          });
        }

        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!user) {
          return new Response("No user found", {
            status: 400,
          });
        }

        await db
          .update(users)
          .set({
            stripeSubscriptionId: event.data.object.subscription as string,
            stripeSubscriptionStatus: event.data.object.status,
          })
          .where(eq(users.id, foundUserId));
      }

      if (event.type === "customer.subscription.updated") {
        const customer = await stripe.customers.retrieve(
          event.data.object.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          return new Response("No user found", {
            status: 400,
          });
        }

        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!user) {
          return new Response("No user found", {
            status: 400,
          });
        }

        await db
          .update(users)
          .set({
            stripeSubscriptionStatus: event.data.object.status,
          })
          .where(eq(users.id, foundUserId));
      }

      if (event.type === "customer.subscription.deleted") {
        const customer = await stripe.customers.retrieve(
          event.data.object.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          return new Response("No user found", {
            status: 400,
          });
        }

        const user = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!user) {
          return new Response("No user found", {
            status: 400,
          });
        }

        await db
          .update(users)
          .set({
            stripeSubscriptionStatus: event.data.object.status,
          })
          .where(eq(users.id, foundUserId));
      }
    } catch (error) {
      return new Response(
        'Webhook error: "Webhook handler failed. View logs."',
        {
          status: 400,
        }
      );
    }
  } else {
    return new Response(`Unrecognised event: ${event.type}`, {
      status: 400,
    });
  }

  return NextResponse.json({ received: true });
};
