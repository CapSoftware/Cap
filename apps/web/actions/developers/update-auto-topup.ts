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
	if (!user) throw new Error("未授权");

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

	if (!app) throw new Error("未找到应用");

	if (
		data.thresholdMicroCredits !== undefined &&
		data.thresholdMicroCredits < 0
	) {
		throw new Error("阈值不能为负数");
	}
	if (data.amountCents !== undefined && data.amountCents <= 0) {
		throw new Error("充值金额必须大于零");
	}
	if (data.amountCents !== undefined && data.amountCents > 100_000) {
		throw new Error("充值金额必须在 $0.01 到 $1,000.00 之间");
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
