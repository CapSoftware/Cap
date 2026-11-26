import { stripe } from "@cap/utils";
import { parsePromotionCode } from "./plans";
import { isRejectedCoupon } from "./referral";

export async function findPromotionCodeId(
	value: unknown,
): Promise<string | null> {
	const code = parsePromotionCode(value);
	if (!code) return null;
	try {
		const { data } = await stripe().promotionCodes.list({
			code,
			active: true,
			limit: 1,
		});
		return data[0]?.id ?? null;
	} catch (error) {
		console.error("[checkout] promotion code lookup failed", { code, error });
		return null;
	}
}

// Stripe rejects discounts together with allow_promotion_codes, so a session
// carrying a campaign code has no code box of its own.
export const promotionParams = (promotionCodeId: string | null) =>
	promotionCodeId
		? { discounts: [{ promotion_code: promotionCodeId }] }
		: { allow_promotion_codes: true as const };

// A campaign code Stripe won't apply to this price (restricted, used up,
// expired since the lookup) must never stop someone paying: retry with the
// ordinary code box instead.
export async function createWithPromotion<T>(
	promotionCodeId: string | null,
	create: (promotionCodeId: string | null) => Promise<T>,
): Promise<T> {
	try {
		return await create(promotionCodeId);
	} catch (error) {
		if (!promotionCodeId || !isRejectedCoupon(error)) throw error;
		return create(null);
	}
}
