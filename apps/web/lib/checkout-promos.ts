import { stripe } from "@cap/utils";
import { normalizeUrlPromoCode } from "@/lib/promo-codes";

/**
 * Resolves a campaign code to the Stripe promotion code id Checkout expects.
 *
 * Returns null for anything not on the allowlist, and for allowlisted codes
 * that have since been deactivated or expired, so the caller falls back to the
 * normal "enter a code yourself" checkout rather than failing the purchase.
 */
export async function resolveUrlPromotionCodeId(
	value: unknown,
): Promise<string | null> {
	const code = normalizeUrlPromoCode(value);
	if (!code) return null;

	try {
		const codes = await stripe().promotionCodes.list({
			code,
			active: true,
			limit: 1,
		});
		return codes.data[0]?.id ?? null;
	} catch (error) {
		console.error("Failed to resolve promotion code", error);
		return null;
	}
}

/**
 * Stripe rejects `discounts` and `allow_promotion_codes` together, so a session
 * either arrives with a campaign discount already applied or offers the promo
 * input. Spread this into the session params.
 */
export function checkoutDiscountParams(promotionCodeId: string | null) {
	return promotionCodeId
		? { discounts: [{ promotion_code: promotionCodeId }] }
		: { allow_promotion_codes: true };
}
