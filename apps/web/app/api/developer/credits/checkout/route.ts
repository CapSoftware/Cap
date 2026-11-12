import { db } from "@cap/database";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { z } from "zod";
import { developerCreditsProductId } from "@/lib/developer-credits-product";
import { ensureDeveloperStripeCustomer } from "@/lib/developer-stripe-customer";
import { canUseInfra } from "@/lib/infra-access";
import { CREDIT_CODE_MAX_LENGTH } from "@/lib/infra-credit-code";
import { findCreditCode } from "@/lib/infra-credit-code-lookup";
import { infraAppPath } from "@/lib/infra-routes";
import { zValidator } from "@/utils/zod-validator";
import { corsMiddleware, withAuth } from "../../../utils";

const CODE_REFUSED = "That code cannot be used for this purchase";

const isInvalidRequest = (error: unknown) =>
	typeof error === "object" &&
	error !== null &&
	(error as { type?: unknown }).type === "StripeInvalidRequestError";

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
			code: z.string().trim().min(1).max(CREDIT_CODE_MAX_LENGTH).optional(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { appId, amountCents, code } = c.req.valid("json");

		if (!canUseInfra(user.email)) {
			return c.json({ error: "Cap Infra credits are not available yet" }, 403);
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

		let promotionCodeId: string | null = null;
		if (code) {
			try {
				promotionCodeId = await findCreditCode(code);
			} catch (error) {
				console.error("Error looking up a credit code:", error);
				return c.json({ error: "Failed to create checkout session" }, 500);
			}
			if (!promotionCodeId) {
				return c.json({ error: CODE_REFUSED }, 400);
			}
		}

		try {
			const customerId = await ensureDeveloperStripeCustomer({
				user,
				account,
			});

			const checkoutSession = await stripe().checkout.sessions.create({
				customer: customerId,
				...(promotionCodeId
					? { discounts: [{ promotion_code: promotionCodeId }] }
					: {}),
				line_items: [
					{
						price_data: {
							currency: "usd",
							product: developerCreditsProductId(),
							unit_amount: amountCents,
						},
						quantity: 1,
					},
				],
				mode: "payment",
				success_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}?purchase=success`,
				cancel_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}`,
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
			if (promotionCodeId && isInvalidRequest(error)) {
				return c.json({ error: CODE_REFUSED }, 400);
			}
			return c.json({ error: "Failed to create checkout session" }, 500);
		}
	},
);

export const POST = handle(app);
export const OPTIONS = handle(app);
