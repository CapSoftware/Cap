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
async function findUserWithRetry(email: string, userId?: string, maxRetries = 5): Promise<typeof users.$inferSelect | null> {
  for (let i = 0; i < maxRetries; i++) {
    console.log(`[Attempt ${i + 1}/${maxRetries}] Looking for user:`, { email, userId });
    
    try {
      // Try finding by userId first if available
      if (userId) {
        console.log(`Attempting to find user by ID: ${userId}`);
        const userById = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .then(rows => rows[0] ?? null);
        
        if (userById) {
          console.log(`Found user by ID: ${userId}`);
          return userById;
        }
        console.log(`No user found by ID: ${userId}`);
      }

      // If not found by ID or no ID provided, try email
      if (email) {
        console.log(`Attempting to find user by email: ${email}`);
        const userByEmail = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)
          .then(rows => rows[0] ?? null);
        
        if (userByEmail) {
          console.log(`Found user by email: ${email}`);
          return userByEmail;
        }
        console.log(`No user found by email: ${email}`);
      }
      
      // If we reach here, no user was found on this attempt
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 3000; // 3s, 6s, 12s, 24s, 48s
        console.log(`No user found on attempt ${i + 1}. Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.error(`Error during attempt ${i + 1}:`, error);
      // If this is not the last attempt, continue to next retry
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 3000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
    }
  }
  
  console.log('All attempts exhausted. No user found.');
  return null;
}

export const POST = async (req: Request) => {
  console.log('Webhook received');
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
        console.log('Processing checkout.session.completed event');
        const session = event.data.object as Stripe.Checkout.Session;
        console.log('Session data:', {
          id: session.id,
          customerId: session.customer,
          subscriptionId: session.subscription
        });

        const customer = await stripe.customers.retrieve(
          session.customer as string
        );
        console.log('Retrieved customer:', {
          id: customer.id,
          email: 'email' in customer ? customer.email : undefined,
          metadata: 'metadata' in customer ? customer.metadata : undefined
        });
        
        let foundUserId;
        let customerEmail;
        
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if ("email" in customer) {
          customerEmail = customer.email;
        }

        console.log("Starting user lookup with:", { foundUserId, customerEmail });
        
        // Try to find user with retries
        const dbUser = await findUserWithRetry(customerEmail as string, foundUserId);
        
        if (!dbUser) {
          console.log("No user found after all retries. Returning 202 to allow retry.");
          return new Response("User not found, webhook will be retried", {
            status: 202,
          });
        }

        console.log("Successfully found user:", {
          userId: dbUser.id,
          email: dbUser.email,
          name: dbUser.name
        });

        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );
        console.log('Retrieved subscription:', {
          id: subscription.id,
          status: subscription.status
        });

        const inviteQuota = subscription.items.data.reduce(
          (total, item) => total + (item.quantity || 1),
          0
        );

        console.log('Updating user in database with:', {
          subscriptionId: session.subscription,
          status: subscription.status,
          customerId: customer.id,
          inviteQuota
        });

        await db
          .update(users)
          .set({
            stripeSubscriptionId: session.subscription as string,
            stripeSubscriptionStatus: subscription.status,
            stripeCustomerId: customer.id,
            inviteQuota: inviteQuota,
          })
          .where(eq(users.id, dbUser.id));
        
        console.log("Successfully updated user in database");
      }

      if (event.type === "customer.subscription.updated") {
        console.log('Processing customer.subscription.updated event');
        const subscription = event.data.object as Stripe.Subscription;
        console.log('Subscription data:', {
          id: subscription.id,
          status: subscription.status,
          customerId: subscription.customer
        });

        const customer = await stripe.customers.retrieve(
          subscription.customer as string
        );
        console.log('Retrieved customer:', {
          id: customer.id,
          email: 'email' in customer ? customer.email : undefined,
          metadata: 'metadata' in customer ? customer.metadata : undefined
        });

        let foundUserId;
        let customerEmail;
        
        if ("metadata" in customer) {
          foundUserId = customer.metadata.userId;
        }
        if ("email" in customer) {
          customerEmail = customer.email;
        }

        console.log("Starting user lookup with:", { foundUserId, customerEmail });
        
        // Try to find user with retries
        const dbUser = await findUserWithRetry(customerEmail as string, foundUserId);
        
        if (!dbUser) {
          console.log("No user found after all retries. Returning 202 to allow retry.");
          return new Response("User not found, webhook will be retried", {
            status: 202,
          });
        }

        console.log("Successfully found user:", {
          userId: dbUser.id,
          email: dbUser.email,
          name: dbUser.name
        });

        // Get all active subscriptions for this customer
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'active',
        });

        console.log('Retrieved all active subscriptions:', {
          count: subscriptions.data.length
        });

        // Calculate total invite quota based on all active subscriptions
        const inviteQuota = subscriptions.data.reduce((total, sub) => {
          return total + sub.items.data.reduce(
            (subTotal, item) => subTotal + (item.quantity || 1),
            0
          );
        }, 0);

        console.log('Updating user in database with:', {
          subscriptionId: subscription.id,
          status: subscription.status,
          customerId: customer.id,
          inviteQuota
        });

        await db
          .update(users)
          .set({
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: subscription.status,
            stripeCustomerId: customer.id,
            inviteQuota: inviteQuota,
          })
          .where(eq(users.id, dbUser.id));
        
        console.log("Successfully updated user in database with new invite quota:", inviteQuota);
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
      console.error("❌ Webhook handler failed:", error);
      return new Response(
        'Webhook error: "Webhook handler failed. View logs."',
        { status: 400 }
      );
    }
  }

  console.log(`Unrecognised event: ${event.type}`);
  return new Response(`Unrecognised event: ${event.type}`, { status: 400 });
};
