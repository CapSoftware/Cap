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
    if (!sig || !webhookSecret) {
      console.log("❌ Missing webhook secret or signature");
      return new Response("Missing webhook secret or signature", { status: 400 });
    }
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
    console.log(`✅ Event received: ${event.type}`);
  } catch (err: any) {
    console.log(`❌ Error message: ${err.message}`);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (relevantEvents.has(event.type)) {
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const customer = await stripe.customers.retrieve(
          session.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          console.log("No user found in metadata, checking customer email");
          if ("email" in customer && customer.email) {
            const userByEmail = await db
              .select()
              .from(users)
              .where(eq(users.email, customer.email))
              .limit(1);

            if (userByEmail && userByEmail.length > 0 && userByEmail[0]) {
              foundUserId = userByEmail[0].id;
              console.log(`User found by email: ${foundUserId}`);
              // Update customer metadata with userId
              await stripe.customers.update(customer.id, {
                metadata: { userId: foundUserId },
              });
            } else {
              console.log("No user found by email");
              return new Response("No user found", {
                status: 400,
              });
            }
          } else {
            console.log("No email found for customer");
            return new Response("No user found", {
              status: 400,
            });
          }
        }

        const userResult = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!userResult || userResult.length === 0) {
          console.log("No user found in database");
          return new Response("No user found", { status: 400 });
        }

        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );
        const inviteQuota = subscription.items.data.reduce(
          (total, item) => total + (item.quantity || 1),
          0
        );

        await db
          .update(users)
          .set({
            stripeSubscriptionId: session.subscription as string,
            stripeSubscriptionStatus: session.status,
            inviteQuota: inviteQuota,
          })
          .where(eq(users.id, foundUserId));
        
        console.log("User updated successfully", { foundUserId, inviteQuota });
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object as Stripe.Subscription;
        const customer = await stripe.customers.retrieve(
          subscription.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          console.log("No user found in metadata, checking customer email");
          if ("email" in customer && customer.email) {
            const userByEmail = await db
              .select()
              .from(users)
              .where(eq(users.email, customer.email))
              .limit(1);

            if (userByEmail && userByEmail.length > 0 && userByEmail[0]) {
              foundUserId = userByEmail[0].id;
              console.log(`User found by email: ${foundUserId}`);
              // Update customer metadata with userId
              await stripe.customers.update(customer.id, {
                metadata: { userId: foundUserId },
              });
            } else {
              console.log("No user found by email");
              return new Response("No user found", {
                status: 400,
              });
            }
          } else {
            console.log("No email found for customer");
            return new Response("No user found", {
              status: 400,
            });
          }
        }

        const userResult = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!userResult || userResult.length === 0) {
          console.log("No user found in database");
          return new Response("No user found", { status: 400 });
        }

        const inviteQuota = subscription.items.data.reduce(
          (total, item) => total + (item.quantity || 1),
          0
        );

        await db
          .update(users)
          .set({
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: subscription.status,
            inviteQuota: inviteQuota,
          })
          .where(eq(users.id, foundUserId));
        
        console.log("User updated successfully", { foundUserId, inviteQuota });
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object as Stripe.Subscription;
        const customer = await stripe.customers.retrieve(
          subscription.customer as string
        );
        let foundUserId;
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if (!foundUserId) {
          console.log("No user found in metadata, checking customer email");
          if ("email" in customer && customer.email) {
            const userByEmail = await db
              .select()
              .from(users)
              .where(eq(users.email, customer.email))
              .limit(1);

            if (userByEmail && userByEmail.length > 0 && userByEmail[0]) {
              foundUserId = userByEmail[0].id;
              console.log(`User found by email: ${foundUserId}`);
              // Update customer metadata with userId
              await stripe.customers.update(customer.id, {
                metadata: { userId: foundUserId },
              });
            } else {
              console.log("No user found by email");
              return new Response("No user found", {
                status: 400,
              });
            }
          } else {
            console.log("No email found for customer");
            return new Response("No user found", {
              status: 400,
            });
          }
        }

        const userResult = await db
          .select()
          .from(users)
          .where(eq(users.id, foundUserId));

        if (!userResult || userResult.length === 0) {
          console.log("No user found in database");
          return new Response("No user found", { status: 400 });
        }

        await db
          .update(users)
          .set({
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: subscription.status,
            inviteQuota: 1, // Reset to default quota
          })
          .where(eq(users.id, foundUserId));
        
        console.log("User updated successfully", { foundUserId, inviteQuota: 1 });
      }

      return NextResponse.json({ received: true });
    } catch (error) {
      console.log("❌ Webhook handler failed:", error);
      return new Response(
        'Webhook error: "Webhook handler failed. View logs."',
        { status: 400 }
      );
    }
  }

  console.log(`Unrecognised event: ${event.type}`);
  return new Response(`Unrecognised event: ${event.type}`, { status: 400 });
};
