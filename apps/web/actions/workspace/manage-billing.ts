'use server';

import { stripe } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { eq } from "drizzle-orm";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { clientEnv } from "@cap/env";

export async function manageBilling() {
  const user = await getCurrentUser();
  let customerId = user?.stripeCustomerId;

  if (!user) {
    throw new Error("Unauthorized");
  }

  if (!user.stripeCustomerId) {
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
  }

  const { url } = await stripe.billingPortal.sessions.create({
    customer: customerId as string,
    return_url: `${clientEnv.NEXT_PUBLIC_WEB_URL}/dashboard/settings/workspace`,
  });
  
  return url;
} 