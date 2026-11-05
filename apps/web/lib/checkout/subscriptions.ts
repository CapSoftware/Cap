import { isProSubscription } from "@cap/utils";

type Subscription = Parameters<typeof isProSubscription>[0] & {
	status: string;
};

const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export function hasLiveProSubscription(subscriptions: readonly Subscription[]) {
	return subscriptions.some(
		(subscription) =>
			isProSubscription(subscription) &&
			LIVE_SUBSCRIPTION_STATUSES.has(subscription.status),
	);
}
