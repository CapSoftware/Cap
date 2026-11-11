import { serverEnv } from "@cap/env";
import { STRIPE_DEVELOPER_CREDITS_PRODUCT_ID } from "@cap/utils";

export function developerCreditsProductId() {
	const mode =
		serverEnv().VERCEL_ENV === "production" ? "production" : "development";
	return STRIPE_DEVELOPER_CREDITS_PRODUCT_ID[mode];
}
