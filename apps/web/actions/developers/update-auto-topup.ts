"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canUseInfra } from "@/lib/infra-access";
import { actionFailure } from "@/lib/infra-action-result";
import { autoTopUpSettingsError } from "@/lib/infra-auto-top-up";

export async function updateDeveloperAutoTopUp(data: {
	appId: string;
	enabled: boolean;
	thresholdMicroCredits?: number;
	amountCents?: number;
}) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const [account] = await db()
		.select({
			id: developerCreditAccounts.id,
			stripePaymentMethodId: developerCreditAccounts.stripePaymentMethodId,
			autoTopUpThresholdMicroCredits:
				developerCreditAccounts.autoTopUpThresholdMicroCredits,
			autoTopUpAmountCents: developerCreditAccounts.autoTopUpAmountCents,
		})
		.from(developerCreditAccounts)
		.innerJoin(
			developerApps,
			eq(developerCreditAccounts.appId, developerApps.id),
		)
		.where(
			and(
				eq(developerApps.id, data.appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!account) throw new Error("App not found");

	const thresholdMicroCredits =
		data.thresholdMicroCredits ?? account.autoTopUpThresholdMicroCredits;
	const amountCents = data.amountCents ?? account.autoTopUpAmountCents;
	const invalid = autoTopUpSettingsError({
		enabled: data.enabled,
		thresholdMicroCredits,
		amountCents,
		hasCard: !!account.stripePaymentMethodId,
	});
	if (invalid) return actionFailure(invalid);

	await db()
		.update(developerCreditAccounts)
		.set(
			data.enabled
				? {
						autoTopUpEnabled: true,
						autoTopUpThresholdMicroCredits: thresholdMicroCredits,
						autoTopUpAmountCents: amountCents,
					}
				: { autoTopUpEnabled: false },
		)
		.where(eq(developerCreditAccounts.id, account.id));

	revalidatePath("/dashboard/infra", "layout");
	return { success: true as const };
}
