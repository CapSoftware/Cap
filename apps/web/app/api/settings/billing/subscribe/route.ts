import { stripe } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  let customerId = user?.stripeCustomerId;
  const { priceId } = await request.json();

  if (!priceId) {
    console.error("Price ID not found");

    return new Response(JSON.stringify({ error: true }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  if (!user) {
    console.error("User not found");

    return new Response(JSON.stringify({ error: true }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    });
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

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId as string,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: "subscription",
    success_url: `${process.env.NEXT_PUBLIC_URL}/dashboard/caps?upgrade=true`,
    cancel_url: `${process.env.NEXT_PUBLIC_URL}/pricing`,
  });

  if (checkoutSession.url) {
    return new Response(JSON.stringify({ url: checkoutSession.url }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  return new Response(JSON.stringify({ error: true }), {
    status: 400,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
