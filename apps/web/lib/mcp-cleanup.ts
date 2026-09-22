import "server-only";

import { db } from "@cap/database";
import { mcpOAuthCodes, mcpOAuthTokens } from "@cap/database/schema";
import { lt } from "drizzle-orm";

const affectedRows = (value: unknown) => {
	const result = Array.isArray(value) ? value[0] : value;
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export const cleanupExpiredMcpRecords = async (now = new Date()) => {
	const database = db();
	let codes = 0;
	let tokens = 0;
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await database
				.delete(mcpOAuthCodes)
				.where(lt(mcpOAuthCodes.expiresAt, now))
				.limit(1_000),
		);
		codes += deleted;
		if (deleted < 1_000) break;
	}
	for (let batch = 0; batch < 10; batch += 1) {
		const deleted = affectedRows(
			await database
				.delete(mcpOAuthTokens)
				.where(lt(mcpOAuthTokens.refreshExpiresAt, now))
				.limit(1_000),
		);
		tokens += deleted;
		if (deleted < 1_000) break;
	}
	return { codes, tokens };
};
