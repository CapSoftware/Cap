import { db } from "@cap/database";
import {
	developerCreditAccounts,
	developerTranscripts,
} from "@cap/database/schema";
import { and, eq, ne, sql } from "drizzle-orm";
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

export const AVAILABLE_AFTER_FIELD = "availableAfterMicroCredits";

export const heldTranscriptsQuery = (
	executor: Pick<InfraDbExecutor, "select">,
	appId: string,
	exceptTranscriptId: string | null,
) =>
	executor
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
				exceptTranscriptId
					? ne(developerTranscripts.id, exceptTranscriptId)
					: undefined,
			),
		);

export async function heldTranscriptMicroCredits(
	executor: Pick<InfraDbExecutor, "select">,
	appId: string,
	exceptTranscriptId: string | null = null,
) {
	const [held] = await heldTranscriptsQuery(
		executor,
		appId,
		exceptTranscriptId,
	);
	return Number(held?.total ?? 0) || 0;
}

export async function readBalanceAndHolds(
	appId: string,
	executor: Pick<InfraDbExecutor, "select"> = db(),
): Promise<{
	id: string;
	balanceMicroCredits: number;
	heldMicroCredits: number;
} | null> {
	const [row] = await executor
		.select({
			id: developerCreditAccounts.id,
			balanceMicroCredits: developerCreditAccounts.balanceMicroCredits,
			heldMicroCredits: sql<
				string | number | null
			>`(${heldTranscriptsQuery(executor, appId, null)})`,
		})
		.from(developerCreditAccounts)
		.where(eq(developerCreditAccounts.appId, appId))
		.limit(1);
	return row
		? {
				id: row.id,
				balanceMicroCredits: row.balanceMicroCredits,
				heldMicroCredits: Number(row.heldMicroCredits ?? 0) || 0,
			}
		: null;
}

export async function availableBalance(
	appId: string,
	executor: InfraDbExecutor = db(),
): Promise<number | null> {
	const account = await readBalanceAndHolds(appId, executor);
	return account
		? account.balanceMicroCredits - account.heldMicroCredits
		: null;
}

export const heldTranscriptsByApp = (
	executor: Pick<InfraDbExecutor, "select">,
) =>
	executor
		.select({
			appId: developerTranscripts.appId,
			heldMicroCredits:
				sql<number>`COALESCE(SUM(${developerTranscripts.reservedMicroCredits}), 0)`.as(
					"heldMicroCredits",
				),
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.status, "processing"))
		.groupBy(developerTranscripts.appId)
		.as("held");
