import { stripe } from "@cap/utils";
import { developerCreditsProductId } from "@/lib/developer-credits-product";

export async function findCreditCode(code: string) {
	const found = await stripe().promotionCodes.list({
		code,
		active: true,
		limit: 1,
		expand: ["data.coupon.applies_to"],
	});
	const promotion = found.data[0];
	if (!promotion?.coupon.valid) return null;
	const product = developerCreditsProductId();
	const products = promotion.coupon.applies_to?.products ?? [];
	if (!product || !products.includes(product)) return null;
	return promotion.id;
}
