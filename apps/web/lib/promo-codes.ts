/**
 * Campaign codes that may be applied straight from a `?promo=` URL parameter,
 * shared by the client (to show the code is active) and the checkout routes
 * (to actually apply it).
 *
 * This MUST stay an allowlist. The Stripe account carries several unrestricted
 * 100%-off codes (staff gifts, internal tests), so honouring whatever a query
 * string asks for would hand out free Cap Pro to anyone who guessed one.
 */
export const URL_PROMO_CODES: Record<string, { label: string }> = {
	MIGRATE20: { label: "20% off Cap Pro" },
};

export function normalizeUrlPromoCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const code = value.trim().toUpperCase();
	return code in URL_PROMO_CODES ? code : null;
}
