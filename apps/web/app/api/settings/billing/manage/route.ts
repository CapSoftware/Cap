import { stripe } from "@cap/utils";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@cap/database";
import { users } from "@cap/database/schema";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  let customerId = user?.stripeCustomerId;

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
    return_url: `${process.env.NEXT_PUBLIC_URL}/dashboard/settings/billing`,
  });
  return NextResponse.json(url);
}
