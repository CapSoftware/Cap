import "server-only";

import { db } from "@cap/database";
import {
	agentApiAuthorizationCodes,
	agentApiIdempotency,
	agentApiKeys,
	agentApiOperations,
} from "@cap/database/schema";
import { and, inArray, lt, or } from "drizzle-orm";

const affectedRows = (result: unknown) =>
	Array.isArray(result)
		? ((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((result as { affectedRows?: number }).affectedRows ?? 0);

const deleteInBatches = async (
	deleteBatch: () => Promise<unknown>,
	batchSize: number,
	maxBatches: number,
) => {
	let deleted = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const count = affectedRows(await deleteBatch());
		deleted += count;
		if (count < batchSize) break;
	}
	return deleted;
};

export const cleanupExpiredAgentApiRecords = async (input?: {
	now?: Date;
	batchSize?: number;
	maxBatches?: number;
	keyRetentionMs?: number;
	operationRetentionMs?: number;
}) => {
	const now = input?.now ?? new Date();
	const batchSize = Math.min(Math.max(input?.batchSize ?? 1_000, 1), 5_000);
	const maxBatches = Math.min(Math.max(input?.maxBatches ?? 10, 1), 20);
	const keyRetentionMs = Math.max(
		input?.keyRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
		0,
	);
	const operationRetentionMs = Math.max(
		input?.operationRetentionMs ?? 30 * 24 * 60 * 60 * 1_000,
		0,
	);
	const keyRetentionCutoff = new Date(now.getTime() - keyRetentionMs);
	const operationRetentionCutoff = new Date(
		now.getTime() - operationRetentionMs,
	);
	const database = db();

	const authorizationCodes = await deleteInBatches(
		() =>
			database
				.delete(agentApiAuthorizationCodes)
				.where(lt(agentApiAuthorizationCodes.expiresAt, now))
				.limit(batchSize),
		batchSize,
		maxBatches,
	);
	const idempotencyRecords = await deleteInBatches(
		() =>
			database
				.delete(agentApiIdempotency)
				.where(lt(agentApiIdempotency.expiresAt, now))
				.limit(batchSize),
		batchSize,
		maxBatches,
	);
	const operations = await deleteInBatches(
		() =>
			database
				.delete(agentApiOperations)
				.where(
					and(
						inArray(agentApiOperations.state, ["succeeded", "failed"]),
						lt(agentApiOperations.updatedAt, operationRetentionCutoff),
					),
				)
				.limit(batchSize),
		batchSize,
		maxBatches,
	);
	const accessTokens = await deleteInBatches(
		() =>
			database
				.delete(agentApiKeys)
				.where(
					or(
						lt(agentApiKeys.expiresAt, keyRetentionCutoff),
						lt(agentApiKeys.revokedAt, keyRetentionCutoff),
					),
				)
				.limit(batchSize),
		batchSize,
		maxBatches,
	);

	return { authorizationCodes, idempotencyRecords, operations, accessTokens };
};
