import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export async function ensureStripeCustomerId(
	user: Pick<typeof users.$inferSelect, "id" | "email" | "stripeCustomerId">,
): Promise<string> {
	if (user.stripeCustomerId) return user.stripeCustomerId;

	const existingCustomers = await stripe().customers.list({
		email: user.email,
		limit: 1,
	});

	let customer: Stripe.Customer;
	const existing = existingCustomers.data[0];
	if (existing) {
		customer = await stripe().customers.update(existing.id, {
			metadata: {
				...existing.metadata,
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
		.set({ stripeCustomerId: customer.id })
		.where(eq(users.id, user.id));

	return customer.id;
}
