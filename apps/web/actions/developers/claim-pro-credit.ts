"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import { canUseInfra } from "@/lib/infra-access";
import { claimProMonthlyCredit } from "@/lib/infra-pro-credit";

export async function claimDeveloperProCredit(appId: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");
	if (!userIsPro(user)) {
		throw new Error("This credit comes with Cap Pro");
	}

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

	const result = await claimProMonthlyCredit({
		userId: user.id,
		accountId: account.id,
		now: new Date(),
	});

	if (!result.claimed) {
		throw new Error("This month's credit has already been claimed");
	}

	return { balanceMicroCredits: result.balanceMicroCredits };
}
