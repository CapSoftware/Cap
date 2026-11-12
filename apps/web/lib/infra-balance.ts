import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerTranscripts,
} from "@cap/database/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { InfraDbExecutor } from "@/lib/infra-standing";

export async function lockInfraAccount(
	executor: InfraDbExecutor,
	appId: string,
) {
	await executor
		.select({ id: developerCreditAccounts.id })
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.for("update");
}

export async function heldTranscriptMicroCredits(
	executor: Pick<InfraDbExecutor, "select">,
	appId: string,
	exceptTranscriptId: string | null = null,
) {
	const [held] = await executor
		.select({
			total: sql<
				string | number | null
			>`COALESCE(SUM(${developerTranscripts.reservedMicroCredits}), 0)`,
		})
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.appId, appId),
				eq(developerTranscripts.status, "processing"),
				isNull(developerTranscripts.deletedAt),
				exceptTranscriptId
					? ne(developerTranscripts.id, exceptTranscriptId)
					: undefined,
			),
		);
	return Number(held?.total ?? 0) || 0;
}

export async function availableBalance(
	appId: string,
	executor: InfraDbExecutor = db(),
): Promise<number | null> {
	const [account] = await executor
		.select({
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	if (!account) return null;
	return (
		account.balanceMicroCredits -
		(await heldTranscriptMicroCredits(executor, appId))
	);
}
