import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	let customerId = user?.stripeCustomerId;

	if (!user) {
		console.error("User not found");

		return Response.json({ error: true }, { status: 401 });
	}

	if (!user.stripeCustomerId) {
		const existingCustomers = await stripe().customers.list({
			email: user.email,
			limit: 1,
		});

		let customer: Stripe.Customer;
		if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
			customer = existingCustomers.data[0];

			customer = await stripe().customers.update(customer.id, {
				metadata: {
					...customer.metadata,
					userId: user.id,
				},
			});
		} else {
			customer = await stripe().customers.create({
				email: user.email,
				metadata: {
					userId: user.id,
				},
			});
		}

		await db()
			.update(users)
			.set({
				stripeCustomerId: customer.id,
			})
			.where(eq(users.id, user.id));

		customerId = customer.id;
	}

	const { url } = await stripe().billingPortal.sessions.create({
		customer: customerId as string,
		return_url: `${serverEnv().WEB_URL}/dashboard/settings/organization`,
	});
	return NextResponse.json(url);
}
