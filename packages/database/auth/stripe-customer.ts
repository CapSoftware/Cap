import { isProSubscription, stripe } from "@cap/utils";
import { eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type Stripe from "stripe";
import { users } from "../schema";

export async function provisionStripeCustomer(
	db: MySql2Database,
	row: typeof users.$inferSelect,
) {
	const existingCustomers = await stripe().customers.list({
		email: row.email,
		limit: 1,
	});

	let customer: Stripe.Customer;
	if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
		customer = existingCustomers.data[0];

		customer = await stripe().customers.update(customer.id, {
			...(row.name?.trim()
				? { name: [row.name, row.lastName].filter(Boolean).join(" ") }
				: {}),
			metadata: {
				...customer.metadata,
				userId: row.id,
			},
		});
	} else {
		customer = await stripe().customers.create(
			{
				email: row.email,
				...(row.name?.trim()
					? { name: [row.name, row.lastName].filter(Boolean).join(" ") }
					: {}),
				metadata: {
					userId: row.id,
				},
			},
			{ idempotencyKey: `cap-signup-${row.id}` },
		);
	}

	const subscriptions = await stripe().subscriptions.list({
		customer: customer.id,
		status: "active",
		limit: 100,
	});

	const proSubscriptions = subscriptions.data.filter(isProSubscription);
	const inviteQuota = proSubscriptions.reduce((total, sub) => {
		return (
			total +
			sub.items.data.reduce(
				(subTotal, item) => subTotal + (item.quantity || 1),
				0,
			)
		);
	}, 0);

	const mostRecentSubscription = proSubscriptions[0];

	await db
		.update(users)
		.set({
			stripeCustomerId: customer.id,
			...(mostRecentSubscription && {
				stripeSubscriptionId: mostRecentSubscription.id,
				stripeSubscriptionStatus: mostRecentSubscription.status,
				inviteQuota: inviteQuota || 1,
			}),
		})
		.where(eq(users.id, row.id));

	const [updatedRow] = await db
		.select()
		.from(users)
		.where(eq(users.id, row.id))
		.limit(1);
	if (updatedRow) {
		row = updatedRow;
	}
	return row;
}
