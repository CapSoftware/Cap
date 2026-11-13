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
import {
	CREDIT_CHECKOUT_METADATA_TYPE,
	creditCheckoutSessionParams,
} from "@/lib/infra-credit-checkout";
import { CREDIT_CODE_MAX_LENGTH } from "@/lib/infra-credit-code";
import { findCreditCode } from "@/lib/infra-credit-code-lookup";
import {
	CREDIT_US_EIN_INVALID,
	CREDIT_US_EIN_MAX_LENGTH,
	parseCreditUsEin,
} from "@/lib/infra-credit-us-ein";
import { saveCreditUsEin } from "@/lib/infra-credit-us-ein-save";
import { infraAppPath } from "@/lib/infra-routes";
import { TOP_UP_MAX_CENTS, TOP_UP_MIN_CENTS } from "@/lib/infra-top-up";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
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
			amountCents: z.number().int().min(TOP_UP_MIN_CENTS).max(TOP_UP_MAX_CENTS),
			code: z.string().trim().min(1).max(CREDIT_CODE_MAX_LENGTH).optional(),
			usEin: z.string().max(CREDIT_US_EIN_MAX_LENGTH).optional(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const { appId, amountCents, code, usEin } = c.req.valid("json");

		if (!canUseInfra(user.email)) {
			return c.json({ error: "Cap Infra credits are not available yet" }, 403);
		}

		const ein = parseCreditUsEin(usEin);
		if (ein.state === "invalid") {
			return c.json({ error: CREDIT_US_EIN_INVALID }, 400);
		}

		if (
			await isRateLimited(RATE_LIMIT_IDS.CHECKOUT, {
				key: `checkout:${user.id}`,
				headers: c.req.raw.headers,
			})
		) {
			return c.json(
				{ error: "Too many checkout attempts. Try again in a few minutes" },
				429,
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
			const limited = await isRateLimited(RATE_LIMIT_IDS.INFRA_CREDIT_CODE, {
				key: `infra-credit-code:${user.id}`,
				headers: c.req.raw.headers,
			});
			if (limited) {
				return c.json(
					{ error: "Too many code attempts. Try again in a few minutes" },
					429,
				);
			}
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

			if (ein.state === "valid") {
				try {
					await saveCreditUsEin(customerId, ein.ein);
				} catch (error) {
					console.error("Error saving a US EIN for developer credits:", error);
					return c.json(
						{ error: "Could not save the EIN. Try again or leave it blank" },
						500,
					);
				}
			}

			const checkoutSession = await stripe().checkout.sessions.create({
				...creditCheckoutSessionParams({
					customerId,
					accountId: account.id,
					appName: app.name,
					amountCents,
					receiptEmail: user.email,
				}),
				...(promotionCodeId
					? { discounts: [{ promotion_code: promotionCodeId }] }
					: {}),
				success_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}?purchase=success`,
				cancel_url: `${serverEnv().WEB_URL}${infraAppPath(appId, "billing")}`,
				metadata: {
					type: CREDIT_CHECKOUT_METADATA_TYPE,
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
