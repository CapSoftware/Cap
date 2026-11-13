import type Stripe from "stripe";
import { developerCreditsProductId } from "@/lib/developer-credits-product";

export const CREDIT_CHECKOUT_METADATA_TYPE = "developer_credits";

export const CREDIT_APP_NAME_MAX_LENGTH = 100;

export const CREDIT_CHECKOUT_PAYMENT_METHOD_TYPES = ["card", "link"] as const;

export function creditAppName(name: string) {
	return Array.from(name.replace(/\s+/g, " ").trim())
		.slice(0, CREDIT_APP_NAME_MAX_LENGTH)
		.join("")
		.trim();
}

export function creditPurchaseDescription(appName: string) {
	const name = creditAppName(appName);
	return name ? `Cap Infra credits for ${name}` : "Cap Infra credits";
}

export function creditCheckoutSubmitMessage(appName: string) {
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
