import "server-only";

import { db } from "@cap/database";
import { deleteBatch } from "@cap/database/batch";
import { affectedRows } from "@cap/database/helpers";
import {
	agentApiAuthorizationCodes,
	agentApiIdempotency,
	agentApiKeys,
	agentApiOperations,
} from "@cap/database/schema";
import { and, inArray, lt, or } from "drizzle-orm";

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
			deleteBatch(
				database,
				agentApiAuthorizationCodes,
				agentApiAuthorizationCodes.id,
				lt(agentApiAuthorizationCodes.expiresAt, now),
				batchSize,
			),
		batchSize,
		maxBatches,
	);
	const idempotencyRecords = await deleteInBatches(
		() =>
			deleteBatch(
				database,
				agentApiIdempotency,
				agentApiIdempotency.id,
				lt(agentApiIdempotency.expiresAt, now),
				batchSize,
			),
		batchSize,
		maxBatches,
	);
	const operations = await deleteInBatches(
		() =>
			deleteBatch(
				database,
				agentApiOperations,
				agentApiOperations.id,
				and(
					inArray(agentApiOperations.state, ["succeeded", "failed"]),
					lt(agentApiOperations.updatedAt, operationRetentionCutoff),
				),
				batchSize,
			),
		batchSize,
		maxBatches,
	);
	const accessTokens = await deleteInBatches(
		() =>
			deleteBatch(
				database,
				agentApiKeys,
				agentApiKeys.id,
				or(
					lt(agentApiKeys.expiresAt, keyRetentionCutoff),
					lt(agentApiKeys.revokedAt, keyRetentionCutoff),
				),
				batchSize,
			),
		batchSize,
		maxBatches,
	);

	return { authorizationCodes, idempotencyRecords, operations, accessTokens };
};
