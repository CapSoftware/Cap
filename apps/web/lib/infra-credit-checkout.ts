import type Stripe from "stripe";
import { developerCreditsProductId } from "@/lib/developer-credits-product";

export const CREDIT_CHECKOUT_METADATA_TYPE = "developer_credits";

export const STRIPE_DESCRIPTION_LIMIT = 1_000;

export const CREDIT_CHECKOUT_PAYMENT_METHOD_TYPES = ["card", "link"] as const;

const CREDIT_PURCHASE_PREFIX = "Cap Infra credits for ";

export function creditAppName(appName: string | null | undefined) {
	return (appName ?? "").replace(/\s+/g, " ").trim();
}

export function creditPurchaseDescription(appName: string | null | undefined) {
	const name = creditAppName(appName);
	if (!name) return "Cap Infra credits";
	const room = STRIPE_DESCRIPTION_LIMIT - CREDIT_PURCHASE_PREFIX.length;
	return `${CREDIT_PURCHASE_PREFIX}${name.slice(0, room).trim()}`;
}

export function creditCheckoutSubmitMessage(
	appName: string | null | undefined,
) {
	return `${creditPurchaseDescription(appName)}. Credit stays with this app and cannot be moved to another app.`;
}

export function creditCheckoutSessionParams({
	customerId,
	accountId,
	appName,
	amountCents,
	receiptEmail,
}: {
	customerId: string;
	accountId: string;
	appName: string;
	amountCents: number;
	receiptEmail: string;
}) {
	const description = creditPurchaseDescription(appName);
	return {
		customer: customerId,
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
		payment_method_types: [...CREDIT_CHECKOUT_PAYMENT_METHOD_TYPES],
		custom_text: {
			submit: { message: creditCheckoutSubmitMessage(appName) },
		},
		invoice_creation: {
			enabled: true,
			invoice_data: { description },
		},
		payment_intent_data: {
			description,
			receipt_email: receiptEmail,
			metadata: { type: CREDIT_CHECKOUT_METADATA_TYPE, accountId },
		},
		tax_id_collection: { enabled: true },
		billing_address_collection: "auto",
		customer_update: { name: "auto", address: "auto" },
	} satisfies Stripe.Checkout.SessionCreateParams;
}
