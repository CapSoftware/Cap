import { db } from "@cap/database";
import {
	developerApps,
	developerCreditAccounts,
	users,
} from "@cap/database/schema";
import { buildEnv, serverEnv } from "@cap/env";
import { STRIPE_DEVELOPER_CREDITS_PRODUCT_ID, stripe } from "@cap/utils";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import type Stripe from "stripe";
import { z } from "zod";
import { corsMiddleware, withAuth } from "../../../utils";

const app = new Hono()
	.basePath("/api/developer/credits/checkout")
	.use(corsMiddleware)
	.use(withAuth);

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			appId: z.string(),
			amountCents: z.number().int().min(500).max(100_000),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { appId, amountCents } = c.req.valid("json");

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
			return c.json({ error: "App not found" }, 404);
		}

		const [account] = await db()
			.select()
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, appId))
			.limit(1);

		if (!account) {
			return c.json({ error: "Credit account not found" }, 404);
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
							product:
								STRIPE_DEVELOPER_CREDITS_PRODUCT_ID[
									buildEnv.NEXT_PUBLIC_IS_CAP ? "production" : "development"
								],
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
				return c.json({ url: checkoutSession.url });
			}

			return c.json({ error: "Failed to create checkout session" }, 500);
		} catch (error) {
			console.error("Error creating developer credits checkout:", error);
			return c.json({ error: "Failed to create checkout session" }, 500);
		}
	},
);

export const POST = handle(app);
export const OPTIONS = handle(app);
