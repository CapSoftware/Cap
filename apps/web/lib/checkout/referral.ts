import {
	findReferralCustomer,
	getReferralDiscount,
	parseDubClickId,
	type ReferralDiscount,
	trackReferralLead,
} from "@cap/database/referrals";

type CheckoutUser = {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
};

/**
 * For a signed-in buyer: returns the partner discount they are owed. A user
 * Dub doesn't know yet who arrived through a partner link is credited to it
 * first. Existing referrals are kept (Dub dedupes leads per user), so a stale
 * click cookie costs no extra Dub call. Every Dub call fails open.
 */
export async function referralDiscountForCheckout(
	user: CheckoutUser,
	clickIdCookie?: string | null,
): Promise<ReferralDiscount | null> {
	const customer = await findReferralCustomer(user.id);
	if (customer.status === "found") return customer.discount;
	if (customer.status === "unavailable") return null;

	const clickId = parseDubClickId(clickIdCookie);
	if (!clickId || !(await trackReferralLead({ clickId, user }))) return null;
	return getReferralDiscount(user.id);
}

/**
 * Creates the checkout session with the referral coupon, retrying without it
 * if Stripe rejects the coupon itself (deleted, expired, used up, wrong
 * currency). A broken Dub discount must never stop someone paying.
 */
export async function createWithReferralDiscount<T>(
	discount: ReferralDiscount | null,
	create: (discount: ReferralDiscount | null) => Promise<T>,
): Promise<T> {
	try {
		return await create(discount);
	} catch (error) {
		if (!discount || !isRejectedCoupon(error)) throw error;
		console.error("[referrals] Stripe rejected the referral coupon", {
			couponId: discount.couponId,
			discountId: discount.discountId,
			error: error instanceof Error ? error.message : String(error),
		});
		return create(null);
	}
}

function isRejectedCoupon(error: unknown) {
	if (!error || typeof error !== "object") return false;
	const { type, param, code } = error as {
		type?: unknown;
		param?: unknown;
		code?: unknown;
	};
	if (type !== "StripeInvalidRequestError") return false;
	return (
		(typeof param === "string" && param.startsWith("discounts")) ||
		code === "coupon_expired"
	);
}

// Stripe rejects discounts together with allow_promotion_codes, so a referred
// buyer gets the partner coupon in place of the promotion code box.
export function referralDiscountParams(discount: ReferralDiscount | null) {
	return discount
		? { discounts: [{ coupon: discount.couponId }] }
		: { allow_promotion_codes: true as const };
}

export function referralDiscountMetadata(
	discount: ReferralDiscount | null,
): Record<string, string> {
	return discount ? { dubDiscountId: discount.discountId } : {};
}

/**
 * Guests have no Cap user yet, so there is no lead to attach a sale to. Dub's
 * Stripe integration instead reads a `dub_id_`-prefixed client_reference_id
 * and records the lead and sale against the Stripe customer itself.
 */
export function guestReferralParams(clickIdCookie?: string | null) {
	const clickId = parseDubClickId(clickIdCookie);
	return clickId ? { client_reference_id: `dub_id_${clickId}` } : {};
}
