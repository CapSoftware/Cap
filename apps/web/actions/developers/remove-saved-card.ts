"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { stripe } from "@cap/utils";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { canUseInfra } from "@/lib/infra-access";

export async function removeDeveloperSavedCard(appId: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");

	const [account] = await db()
		.select({
			id: developerCreditAccounts.id,
			stripePaymentMethodId: developerCreditAccounts.stripePaymentMethodId,
		})
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

	await db()
		.update(developerCreditAccounts)
		.set({ stripePaymentMethodId: null, autoTopUpEnabled: false })
		.where(eq(developerCreditAccounts.id, account.id));

	if (account.stripePaymentMethodId) {
		await stripe()
			.paymentMethods.detach(account.stripePaymentMethodId)
			.catch((error) => {
				console.error("Failed to detach saved card:", error);
			});
	}

	revalidatePath("/dashboard/infra", "layout");
	return { success: true };
}
