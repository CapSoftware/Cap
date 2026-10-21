import "server-only";

import { db } from "@cap/database";
import { deleteBatch } from "@cap/database/batch";
import { affectedRows } from "@cap/database/helpers";
import {
	mcpOAuthClients,
	mcpOAuthCodes,
	mcpOAuthRegistrationQuotas,
	mcpOAuthTokens,
} from "@cap/database/schema";
import { and, eq, gt, isNull, lt, notExists } from "drizzle-orm";

export const cleanupExpiredMcpRecords = async (now = new Date()) => {
	const database = db();
	let codes = 0;
	let tokens = 0;
	let clients = 0;
	let quotas = 0;
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await deleteBatch(
				database,
				mcpOAuthCodes,
				mcpOAuthCodes.id,
				lt(mcpOAuthCodes.expiresAt, now),
				1_000,
			),
		);
		codes += deleted;
		if (deleted < 1_000) break;
	}
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await deleteBatch(
				database,
				mcpOAuthTokens,
				mcpOAuthTokens.id,
				lt(mcpOAuthTokens.refreshExpiresAt, now),
				1_000,
			),
		);
		tokens += deleted;
		if (deleted < 1_000) break;
	}
	const unusedBefore = new Date(now.getTime() - 24 * 60 * 60_000);
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await deleteBatch(
				database,
				mcpOAuthClients,
				mcpOAuthClients.id,
				and(
					isNull(mcpOAuthClients.activatedAt),
					lt(mcpOAuthClients.createdAt, unusedBefore),
				),
				1_000,
			),
		);
		clients += deleted;
		if (deleted < 1_000) break;
	}
	const staleBefore = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await deleteBatch(
				database,
				mcpOAuthClients,
				mcpOAuthClients.id,
				and(
					lt(mcpOAuthClients.activatedAt, staleBefore),
					notExists(
						database
							.select({ id: mcpOAuthTokens.id })
							.from(mcpOAuthTokens)
							.where(
								and(
									eq(mcpOAuthTokens.clientId, mcpOAuthClients.clientId),
									isNull(mcpOAuthTokens.revokedAt),
									gt(mcpOAuthTokens.refreshExpiresAt, now),
								),
							),
					),
				),
				1_000,
			),
		);
		clients += deleted;
		if (deleted < 1_000) break;
	}
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await deleteBatch(
				database,
				mcpOAuthRegistrationQuotas,
				mcpOAuthRegistrationQuotas.windowId,
				lt(mcpOAuthRegistrationQuotas.expiresAt, now),
				1_000,
			),
		);
		quotas += deleted;
		if (deleted < 1_000) break;
	}
	return { codes, tokens, clients, quotas };
};
