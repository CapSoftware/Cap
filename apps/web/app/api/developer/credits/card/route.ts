import { db } from "@cap/database";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";
import { ensureDeveloperStripeCustomer } from "@/lib/developer-stripe-customer";
import { canUseInfra } from "@/lib/infra-access";
import { infraAppPath } from "@/lib/infra-routes";
import { zValidator } from "@/utils/zod-validator";
import { corsMiddleware, withAuth } from "../../../utils";

const app = new Hono()
	.basePath("/api/developer/credits/card")
	.use(corsMiddleware)
	.use(withAuth);

app.post(
	"/",
	zValidator("json", z.object({ appId: z.string() })),
	async (c) => {
		const user = c.get("user");
		const { appId } = c.req.valid("json");

		if (!canUseInfra(user.email)) {
			return c.json({ error: "Cap Infra credits are not available yet" }, 403);
		}

		const [account] = await db()
			.select({
				id: developerCreditAccounts.id,
				stripeCustomerId: developerCreditAccounts.stripeCustomerId,
			})
			.from(developerCreditAccounts)
			.innerJoin(
				developerApps,
				eq(developerCreditAccounts.appId, developerApps.id),
			)
			.where(
				and(
					eq(developerApps.id, appId),
					eq(developerApps.ownerId, user.id),
					isNull(developerApps.deletedAt),
				),
			)
			.limit(1);

		if (!account) {
			return c.json({ error: "App not found" }, 404);
		}

		try {
			const customerId = await ensureDeveloperStripeCustomer({ user, account });
			const metadata = {
				type: "developer_card",
				appId,
				accountId: account.id,
				userId: user.id,
			};
			const session = await stripe().checkout.sessions.create({
				customer: customerId,
				mode: "setup",
				payment_method_types: ["card"],
				success_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}?card=saved`,
				cancel_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}`,
				metadata,
				setup_intent_data: { metadata },
			});

			if (session.url) {
				return c.json({ url: session.url });
			}

			return c.json({ error: "Failed to create checkout session" }, 500);
		} catch (error) {
			console.error("Error creating developer card checkout:", error);
			return c.json({ error: "Failed to create checkout session" }, 500);
		}
	},
);

export const POST = handle(app);
export const OPTIONS = handle(app);
