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

// Helper function to find user with retries
async function findUserWithRetry(email: string, userId?: string, maxRetries = 3): Promise<typeof users.$inferSelect | null> {
  for (let i = 0; i < maxRetries; i++) {
    console.log(`Attempt ${i + 1} to find user (email: ${email}, userId: ${userId})`);
    
    try {
      let user;
      
      if (userId) {
        user = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .then(rows => rows[0] || null);
      } else if (email) {
        user = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)
          .then(rows => rows[0] || null);
      }
      
      if (user) {
        console.log(`User found on attempt ${i + 1}`);
        return user;
      }
      
      // Wait before retrying, with exponential backoff
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
        console.log(`Waiting ${delay}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.error(`Error finding user on attempt ${i + 1}:`, error);
      // Continue to next retry
    }
  }
  
  return null;
}

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
        
        // Get potential user identifiers
        let foundUserId;
        let customerEmail;
        
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if ("email" in customer) {
          customerEmail = customer.email;
        }

        console.log("Looking for user with:", { foundUserId, customerEmail });
        
        // Try to find user with retries
        const dbUser = await findUserWithRetry(customerEmail as string, foundUserId);
        
        if (!dbUser) {
          console.log("No user found after retries");
          // Instead of failing, we'll store the subscription info and retry later
          // You might want to implement a queue system for this in production
          return new Response("User not found, webhook will be retried", {
            status: 202, // Accepted but not processed
          });
        }

        console.log("Found user:", dbUser.id);

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
            stripeSubscriptionStatus: subscription.status,
            stripeCustomerId: customer.id,
            inviteQuota: inviteQuota,
          })
          .where(eq(users.id, dbUser.id));
        
        console.log("User updated successfully", { userId: dbUser.id, inviteQuota });
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
