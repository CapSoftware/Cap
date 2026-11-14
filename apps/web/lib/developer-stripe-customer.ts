import { db } from "@cap/database";
import { developerCreditAccounts, users } from "@cap/database/schema";
import { stripe } from "@cap/utils";
import type { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";

export async function ensureDeveloperStripeCustomer({
	user,
	account,
}: {
	user: { id: User.UserId; email: string; stripeCustomerId: string | null };
	account: { id: string; stripeCustomerId: string | null };
}) {
	const existingId = account.stripeCustomerId ?? user.stripeCustomerId;
	if (existingId) return existingId;

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
		.set({ stripeCustomerId: customer.id })
		.where(eq(users.id, user.id));

	await db()
		.update(developerCreditAccounts)
		.set({ stripeCustomerId: customer.id })
		.where(eq(developerCreditAccounts.id, account.id));

	return customer.id;
}
