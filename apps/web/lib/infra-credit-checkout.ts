import type Stripe from "stripe";
import { developerCreditsProductId } from "@/lib/developer-credits-product";

export const CREDIT_CHECKOUT_METADATA_TYPE = "developer_credits";

export function creditCheckoutSessionParams({
	customerId,
	accountId,
	amountCents,
	receiptEmail,
}: {
	customerId: string;
	accountId: string;
	amountCents: number;
	receiptEmail: string;
}) {
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
		invoice_creation: {
			enabled: true,
			invoice_data: { description: "Cap Infra credits" },
		},
		payment_intent_data: {
			receipt_email: receiptEmail,
			metadata: { type: CREDIT_CHECKOUT_METADATA_TYPE, accountId },
		},
		tax_id_collection: { enabled: true },
		billing_address_collection: "auto",
		customer_update: { name: "auto", address: "auto" },
	} satisfies Stripe.Checkout.SessionCreateParams;
}
