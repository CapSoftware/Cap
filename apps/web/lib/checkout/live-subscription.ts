import { isProSubscription } from "@cap/utils";
import { checkoutStripe } from "@/lib/checkout/stripe";

const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function hasLiveProSubscription(customerId: string) {
	const subscriptions = await checkoutStripe().subscriptions.list({
		customer: customerId,
		limit: 100,
	});
	return subscriptions.data.some(
		(subscription) =>
			isProSubscription(subscription) &&
			LIVE_SUBSCRIPTION_STATUSES.has(subscription.status),
	);
}
