import {
	STRIPE_SAML_SSO_LEGACY_PRICE_ID,
	STRIPE_SAML_SSO_PRICE_ID,
	STRIPE_SAML_SSO_PRODUCT_ID,
	STRIPE_SIGNED_BAA_PRICE_IDS,
} from "../../constants/plans.ts";

type SubscriptionIdentity = {
	metadata?: Record<string, string> | null;
	items?: {
		data: {
			price?: {
				id?: string;
				product?: string | { id: string } | null;
			} | null;
		}[];
	};
};

export function isSsoPrice(priceId: string | null | undefined) {
	return (
		priceId === STRIPE_SAML_SSO_PRICE_ID ||
		priceId === STRIPE_SAML_SSO_LEGACY_PRICE_ID
	);
}

export function isSsoSubscription(subscription: SubscriptionIdentity) {
	return (
		subscription.metadata?.type === "saml_sso" ||
		subscription.items?.data.some((item) => {
			const product = item.price?.product;
			return (
				isSsoPrice(item.price?.id) ||
				(typeof product === "string" ? product : product?.id) ===
					STRIPE_SAML_SSO_PRODUCT_ID
			);
		}) === true
	);
}

export function isProSubscription(subscription: SubscriptionIdentity) {
	return (
		!isSsoSubscription(subscription) &&
		subscription.metadata?.type !== "signed_baa" &&
		!subscription.items?.data.some((item) =>
			Object.values(STRIPE_SIGNED_BAA_PRICE_IDS).some(
				(priceId) => priceId === item.price?.id,
			),
		)
	);
}

export function hasSsoAccess(
	billing: { status: string; paidThrough: Date | null } | null | undefined,
	now = new Date(),
) {
	if (
		!billing?.paidThrough ||
		(billing.status !== "active" && billing.status !== "past_due")
	)
		return false;

	const paidThrough = billing.paidThrough.getTime();
	const grace = billing.status === "past_due" ? 7 * 24 * 60 * 60 * 1000 : 0;
	return Number.isFinite(paidThrough) && now.getTime() < paidThrough + grace;
}
