import { buildEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";

export type ProCreditEligibility = "paid" | "trial" | "not_pro";

export const PRO_CREDIT_TRIAL_MESSAGE =
	"Your $5 monthly Infra credit starts with your first paid month of Cap Pro.";

export const PAID_PRO_STATUSES = new Set([
	"active",
	"complete",
	"paid",
	"past_due",
]);

export function proCreditEligibility(
	user?: {
		stripeSubscriptionStatus?: string | null;
		thirdPartyStripeSubscriptionId?: string | null;
	} | null,
): ProCreditEligibility {
	if (!userIsPro(user)) return "not_pro";
	if (!buildEnv.NEXT_PUBLIC_IS_CAP) return "paid";
	if (
		user?.thirdPartyStripeSubscriptionId ||
		PAID_PRO_STATUSES.has(user?.stripeSubscriptionStatus ?? "")
	) {
		return "paid";
	}
	return "trial";
}
