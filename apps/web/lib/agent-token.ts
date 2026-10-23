import "server-only";

import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Database } from "@cap/web-backend";
import { Agent } from "@cap/web-domain";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
	createAgentAccessToken,
	hashAgentSecret,
	isAgentCodeVerifier,
	isAgentLoopbackRedirectUri,
	verifyAgentCodeChallenge,
} from "./agent-auth";

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const commonError = (requestId: string, message: string) => ({
	message,
	retryable: false,
	retryAfterMs: null,
	requestId,
});

const invalidGrant = (requestId: string) =>
	new Agent.AgentBadRequestError({
		...commonError(requestId, "The authorization grant is invalid"),
		code: "INVALID_REQUEST",
	});

const expiredGrant = (requestId: string) =>
	new Agent.AgentAuthenticationError({
		...commonError(requestId, "The authorization grant has expired"),
		code: "TOKEN_EXPIRED",
	});

export const exchangeAgentAuthorizationCode = Effect.fn(
	"Agent.exchangeAuthorizationCode",
)(function* (
	payload: (typeof Agent.AgentTokenRequest)["Type"],
	requestId: string,
) {
	if (
		payload.code.length < 32 ||
		payload.code.length > 128 ||
		!isAgentCodeVerifier(payload.codeVerifier) ||
		!isAgentLoopbackRedirectUri(payload.redirectUri)
	) {
		return yield* invalidGrant(requestId);
	}

	const database = yield* Database;
	const now = new Date();
	const result = yield* database.use((db) =>
		db.transaction(async (tx) => {
			const [grant] = await tx
				.select()
				.from(Db.agentApiAuthorizationCodes)
				.where(
					eq(
						Db.agentApiAuthorizationCodes.codeHash,
						hashAgentSecret(payload.code),
					),
				)
				.limit(1);
			if (!grant || grant.redirectUri !== payload.redirectUri) {
				return { state: "invalid" as const };
			}
			if (grant.consumedAt || grant.expiresAt.getTime() <= now.getTime()) {
				return { state: "expired" as const };
			}
			if (
				!verifyAgentCodeChallenge(payload.codeVerifier, grant.codeChallenge)
			) {
				return { state: "invalid" as const };
			}

			const consumed = await tx
				.update(Db.agentApiAuthorizationCodes)
				.set({ consumedAt: now })
				.where(
					and(
						eq(Db.agentApiAuthorizationCodes.id, grant.id),
						isNull(Db.agentApiAuthorizationCodes.consumedAt),
						gt(Db.agentApiAuthorizationCodes.expiresAt, now),
					),
				);
			if (getAffectedRows(consumed) !== 1) {
				return { state: "expired" as const };
			}

			const accessToken = createAgentAccessToken();
			const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
			await tx.insert(Db.agentApiKeys).values({
				id: nanoId(),
				userId: grant.userId,
				tokenHash: hashAgentSecret(accessToken),
				scopes: grant.scopes,
				expiresAt,
			});
			return {
				state: "issued" as const,
				accessToken,
				expiresAt,
				scopes: grant.scopes,
			};
		}),
	);

	if (result.state === "invalid") return yield* invalidGrant(requestId);
	if (result.state === "expired") return yield* expiredGrant(requestId);
	return {
		accessToken: result.accessToken,
		tokenType: "Bearer" as const,
		expiresAt: result.expiresAt.toISOString(),
		scopes: result.scopes,
		requestId,
	};
});

export const revokeAgentAccessToken = Effect.fn("Agent.revokeAccessToken")(
	function* (requestId: string) {
		const principal = yield* Agent.AgentPrincipal;
		if (principal.tokenKind !== "agent") {
			return { revoked: false, requestId };
		}
		const database = yield* Database;
		const result = yield* database.use((db) =>
			db
				.update(Db.agentApiKeys)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(Db.agentApiKeys.id, principal.tokenId),
						eq(Db.agentApiKeys.userId, principal.id),
						isNull(Db.agentApiKeys.revokedAt),
					),
				),
		);
		return { revoked: getAffectedRows(result) === 1, requestId };
	},
);

export const getAgentAuthStatus = Effect.fn("Agent.getAuthStatus")(function* (
	requestId: string,
) {
	const principal = yield* Agent.AgentPrincipal;
	return {
		authenticated: true as const,
		tokenKind: principal.tokenKind,
		expiresAt: principal.expiresAt?.toISOString() ?? null,
		scopes: Array.from(principal.scopes),
		requestId,
	};
});
