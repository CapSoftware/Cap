"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";
import {
	claimProMonthlyCredit,
	PRO_CREDIT_CLAIMED_MESSAGE,
	PRO_CREDIT_NOT_PRO_MESSAGE,
	proCreditPayer,
} from "@/lib/infra-pro-credit";
import {
	PRO_CREDIT_TRIAL_MESSAGE,
	proCreditEligibility,
} from "@/lib/infra-pro-credit-eligibility";

export async function claimDeveloperProCredit(appId: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");
	const eligibility = proCreditEligibility(user);
	if (eligibility === "not_pro") {
		return actionFailure(PRO_CREDIT_NOT_PRO_MESSAGE);
	}
	if (eligibility === "trial") return actionFailure(PRO_CREDIT_TRIAL_MESSAGE);

	const [account] = await db()
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!account) throw new Error("App not found");

	const payer = await proCreditPayer(user);
	if (payer.state === "refused") return actionFailure(payer.message);

	const result = await claimProMonthlyCredit({
		userId: user.id,
		accountId: account.id,
		now: new Date(),
		subscription: payer.subscription,
	});

	if (!result.claimed) return actionFailure(PRO_CREDIT_CLAIMED_MESSAGE);

	return { balanceMicroCredits: result.balanceMicroCredits };
}
