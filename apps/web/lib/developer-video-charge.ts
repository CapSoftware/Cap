import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerVideos,
} from "@cap/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { UPLOAD_MICRO_CREDITS_PER_MINUTE } from "./developer-pricing";

export const DEVELOPER_VIDEO_MAX_DURATION_SECONDS = 4 * 60 * 60;

export type DeveloperVideoCharge = "charged" | "insufficient" | "no-account";

export function developerVideoUploadMicroCredits(durationSeconds: number) {
	return Math.floor((durationSeconds / 60) * UPLOAD_MICRO_CREDITS_PER_MINUTE);
}

// Charges the upload fee for durationSeconds, minus whatever this video has
// already paid, so calling it again with a longer duration charges only the
// difference and calling it with the same duration charges nothing.
export async function chargeDeveloperVideoUpload(input: {
	appId: string;
	videoId: string;
	durationSeconds: number;
	metadata: Record<string, unknown>;
}): Promise<DeveloperVideoCharge> {
	const owed = developerVideoUploadMicroCredits(input.durationSeconds);
	if (owed <= 0) return "charged";

	return db().transaction(async (tx) => {
		await tx
			.select({ id: developerVideos.id })
			.from(developerVideos)
			.where(eq(developerVideos.id, input.videoId))
			.for("update");

		const [account] = await tx
			.select({
				id: developerCreditAccounts.id,
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.appId, input.appId))
			.limit(1);
		if (!account) return "no-account";

		const [paid] = await tx
			.select({
				total: sql<number>`COALESCE(SUM(-${developerCreditTransactions.amountMicroCredits}), 0)`,
			})
			.from(developerCreditTransactions)
			.where(
				and(
					eq(developerCreditTransactions.accountId, account.id),
					eq(developerCreditTransactions.referenceId, input.videoId),
					eq(developerCreditTransactions.referenceType, "developer_video"),
					eq(developerCreditTransactions.type, "video_create"),
				),
			);

		const remaining = owed - Number(paid?.total ?? 0);
		if (remaining <= 0) return "charged";

		const [result] = await tx
			.update(developerCreditAccounts)
			.set({
				balanceMicroCredits: sql`${developerCreditAccounts.balanceMicroCredits} - ${remaining}`,
			})
			.where(
				and(
					eq(developerCreditAccounts.id, account.id),
					sql`${developerCreditAccounts.balanceMicroCredits} >= ${remaining}`,
				),
			);
		const affectedRows =
			(result as unknown as { affectedRows?: number })?.affectedRows ?? 0;
		if (affectedRows === 0) return "insufficient";

		const [updated] = await tx
			.select({
				balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			})
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.id, account.id))
			.limit(1);
		if (!updated) return "insufficient";

		await tx.insert(developerCreditTransactions).values({
			id: nanoId(),
			accountId: account.id,
			type: "video_create",
			amountMicroCredits: -remaining,
			balanceAfterMicroCredits: updated.balanceMicroCredits,
			referenceId: input.videoId,
			referenceType: "developer_video",
			metadata: input.metadata,
		});
		return "charged";
	});
}
