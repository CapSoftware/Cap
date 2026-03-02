import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	developerApps,
	developerCreditAccounts,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { STRIPE_DEVELOPER_CREDITS_PRODUCT_ID, stripe } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type Stripe from "stripe";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { appId, amountCents } = await request.json();

	if (
		!appId ||
		typeof amountCents !== "number" ||
		!Number.isInteger(amountCents) ||
		amountCents < 500 ||
		amountCents > 100_000
	) {
		return Response.json(
			{
				error: "Invalid request. Purchase must be between $5.00 and $1,000.00",
			},
			{ status: 400 },
		);
	}

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) {
		return Response.json({ error: "App not found" }, { status: 404 });
	}

	const [account] = await db()
		.select()
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);

	if (!account) {
		return Response.json(
			{ error: "Credit account not found" },
			{ status: 404 },
		);
	}

	try {
		let customerId = account.stripeCustomerId ?? user.stripeCustomerId;

		if (!customerId) {
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

			customerId = customer.id;
		}

		const checkoutSession = await stripe().checkout.sessions.create({
			customer: customerId,
			line_items: [
				{
					price_data: {
						currency: "usd",
						product: STRIPE_DEVELOPER_CREDITS_PRODUCT_ID,
						unit_amount: amountCents,
					},
					quantity: 1,
				},
			],
			mode: "payment",
			success_url: `${serverEnv().WEB_URL}/dashboard/developers/credits?purchase=success`,
			cancel_url: `${serverEnv().WEB_URL}/dashboard/developers/credits`,
			metadata: {
				type: "developer_credits",
				appId,
				accountId: account.id,
				amountCents: String(amountCents),
				userId: user.id,
			},
		});

		if (checkoutSession.url) {
			return Response.json({ url: checkoutSession.url }, { status: 200 });
		}

		return Response.json(
			{ error: "Failed to create checkout session" },
			{ status: 500 },
		);
	} catch (error) {
		console.error("Error creating developer credits checkout:", error);
		return Response.json(
			{ error: "Failed to create checkout session" },
			{ status: 500 },
		);
	}
}
