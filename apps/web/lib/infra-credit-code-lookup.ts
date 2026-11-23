import { stripe } from "@cap/utils";
import { developerCreditsProductId } from "@/lib/developer-credits-product";

export async function findCreditCode(code: string) {
	const found = await stripe().promotionCodes.list({
		code,
		active: true,
		limit: 1,
		expand: ["data.coupon.applies_to"],
	});
	const coupon = found.data[0]?.coupon;
	if (!coupon?.valid) return null;
	if (coupon.percent_off !== null && coupon.percent_off !== undefined) {
		return null;
	}
	if (
		typeof coupon.amount_off !== "number" ||
		coupon.amount_off <= 0 ||
		coupon.currency !== "usd"
	) {
		return null;
	}
	const product = developerCreditsProductId();
	const products = coupon.applies_to?.products ?? [];
	if (!product || !products.includes(product)) return null;
	return found.data[0]?.id ?? null;
}
