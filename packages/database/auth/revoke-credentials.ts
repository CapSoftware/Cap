import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "../index.ts";
import {
	agentApiAuthorizationCodes,
	agentApiKeys,
	authApiKeys,
	authChallenges,
	emailChangeRequests,
	mcpOAuthCodes,
	mcpOAuthTokens,
	sessions,
	userPasskeys,
	users,
} from "../schema.ts";

type Transaction = Pick<ReturnType<typeof db>, "update" | "delete">;

/**
 * Signs the account out everywhere: browser sessions, desktop and mobile keys,
 * CLI keys, MCP apps, passkeys and every pending check or code. Run it inside
 * the caller's transaction. Bumping the session version first takes the
 * account row lock that every credential issuer also takes, so nothing issued
 * concurrently can survive.
 */
export async function revokeAllCredentials(
	tx: Transaction,
	userId: typeof users.$inferSelect.id,
) {
	const now = new Date();
	await tx
		.update(users)
		.set({ authSessionVersion: sql`${users.authSessionVersion} + 1` })
		.where(eq(users.id, userId));
	await tx.delete(sessions).where(eq(sessions.userId, userId));
	await tx.delete(authApiKeys).where(eq(authApiKeys.userId, userId));
	await tx.delete(userPasskeys).where(eq(userPasskeys.userId, userId));
	await tx
		.delete(emailChangeRequests)
		.where(eq(emailChangeRequests.userId, userId));
	await tx.delete(authChallenges).where(eq(authChallenges.userId, userId));
	await tx
		.update(mcpOAuthCodes)
		.set({ consumedAt: now })
		.where(
			and(eq(mcpOAuthCodes.userId, userId), isNull(mcpOAuthCodes.consumedAt)),
		);
	await tx
		.update(mcpOAuthTokens)
		.set({ revokedAt: now })
		.where(
			and(eq(mcpOAuthTokens.userId, userId), isNull(mcpOAuthTokens.revokedAt)),
		);
	await tx
		.update(agentApiAuthorizationCodes)
		.set({ consumedAt: now })
		.where(
			and(
				eq(agentApiAuthorizationCodes.userId, userId),
				isNull(agentApiAuthorizationCodes.consumedAt),
			),
		);
	await tx
		.update(agentApiKeys)
		.set({ revokedAt: now })
		.where(
			and(eq(agentApiKeys.userId, userId), isNull(agentApiKeys.revokedAt)),
		);
}
