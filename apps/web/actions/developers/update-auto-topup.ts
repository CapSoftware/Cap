"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps, developerCreditAccounts } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function updateDeveloperAutoTopUp(data: {
	appId: string;
	enabled: boolean;
	thresholdMicroCredits?: number;
	amountCents?: number;
}) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [app] = await db()
		.select()
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, data.appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);

	if (!app) throw new Error("App not found");

	if (
		data.thresholdMicroCredits !== undefined &&
		data.thresholdMicroCredits < 0
	) {
		throw new Error("Threshold must be non-negative");
	}
	if (
		data.amountCents !== undefined &&
		(data.amountCents <= 0 || data.amountCents > 100_000)
	) {
		throw new Error("Top-up amount must be between $0.01 and $1,000.00");
	}

	const updates: Partial<typeof developerCreditAccounts.$inferInsert> = {
		autoTopUpEnabled: data.enabled,
	};

	if (data.thresholdMicroCredits !== undefined) {
		updates.autoTopUpThresholdMicroCredits = data.thresholdMicroCredits;
	}
	if (data.amountCents !== undefined) {
		updates.autoTopUpAmountCents = data.amountCents;
	}

	await db()
		.update(developerCreditAccounts)
		.set(updates)
		.where(eq(developerCreditAccounts.appId, data.appId));

	revalidatePath("/dashboard/developers");
	return { success: true };
}
