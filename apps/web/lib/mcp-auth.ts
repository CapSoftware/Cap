import "server-only";

import { randomBytes } from "node:crypto";
import { db } from "@cap/database";
import { isBlockedAccountEmail } from "@cap/database/auth/domain-utils";
import { nanoId } from "@cap/database/helpers";
import {
	mcpOAuthClients,
	mcpOAuthCodes,
	mcpOAuthRegistrationQuotas,
	mcpOAuthTokens,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
	hashAgentSecret,
	isAgentCodeChallenge,
	isAgentCodeVerifier,
	verifyAgentCodeChallenge,
} from "./agent-auth";

export const mcpIssuer = () => new URL(serverEnv().WEB_URL).origin;
export const mcpResource = () => `${mcpIssuer()}/api/mcp`;
export const mcpProtectedResourceMetadataUrl = () =>
	`${mcpIssuer()}/.well-known/oauth-protected-resource/api/mcp`;

const accessLifetimeSeconds = 3_600;
const refreshLifetimeSeconds = 30 * 24 * 3_600;
const dailyRegistrationLimit = 5_000;
const token = (prefix: string) =>
	`${prefix}${randomBytes(32).toString("base64url")}`;

export const isMcpRedirectUri = (value: string) => {
	if (value.length > 512) return false;
	try {
		const url = new URL(value);
		const loopback =
			url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
			url.port.length > 0;
		return (
			(url.protocol === "https:" || loopback) &&
			url.username === "" &&
			url.password === "" &&
			url.hash === "" &&
			url.toString() === value
		);
	} catch {
		return false;
	}
};

export type McpAuthorizationRequest = {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string | null;
	resource: string;
};

export const parseMcpAuthorizationRequest = (
	params: URLSearchParams,
	resource: string,
): McpAuthorizationRequest | null => {
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const codeChallenge = params.get("code_challenge");
	const state = params.get("state");
	if (
		!clientId ||
		clientId.length > 128 ||
		!redirectUri ||
		!isMcpRedirectUri(redirectUri) ||
		params.get("response_type") !== "code" ||
		!codeChallenge ||
		!isAgentCodeChallenge(codeChallenge) ||
		params.get("code_challenge_method") !== "S256" ||
		params.get("scope") !== "caps:read" ||
		params.get("resource") !== resource ||
		(state !== null && state.length > 512)
	) {
		return null;
	}
	return { clientId, redirectUri, codeChallenge, state, resource };
};

export const registerMcpClient = async (input: {
	clientName: string;
	redirectUris: string[];
}) => {
	const now = new Date();
	const windowId = now.toISOString().slice(0, 10);
	const clientId = token("cap_mcp_client_");
	const accepted = await db().transaction(async (tx) => {
		await tx
			.insert(mcpOAuthRegistrationQuotas)
			.values({
				windowId,
				registrations: 0,
				expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60_000),
			})
			.onDuplicateKeyUpdate({
				set: {
					windowId: sql`${mcpOAuthRegistrationQuotas.windowId}`,
				},
			});
		const [quota] = await tx
			.select({ registrations: mcpOAuthRegistrationQuotas.registrations })
			.from(mcpOAuthRegistrationQuotas)
			.where(eq(mcpOAuthRegistrationQuotas.windowId, windowId))
			.limit(1)
			.for("update");
		if (!quota || quota.registrations >= dailyRegistrationLimit) return false;
		await tx
			.update(mcpOAuthRegistrationQuotas)
			.set({
				registrations: sql`${mcpOAuthRegistrationQuotas.registrations} + 1`,
			})
			.where(eq(mcpOAuthRegistrationQuotas.windowId, windowId));
		await tx.insert(mcpOAuthClients).values({
			id: nanoId(),
			clientId,
			clientName: input.clientName,
			redirectUris: input.redirectUris,
		});
		return true;
	});
	return accepted ? clientId : null;
};

export const getMcpClient = async (clientId: string) => {
	const [client] = await db()
		.select()
		.from(mcpOAuthClients)
		.where(eq(mcpOAuthClients.clientId, clientId))
		.limit(1);
	return client ?? null;
};

export const validateMcpAuthorizationRequest = async (
	params: URLSearchParams,
) => {
	const parsed = parseMcpAuthorizationRequest(params, mcpResource());
	if (!parsed) return null;
	const client = await getMcpClient(parsed.clientId);
	if (!client || !client.redirectUris.includes(parsed.redirectUri)) return null;
	return { ...parsed, clientName: client.clientName };
};

export const createMcpAuthorizationCode = async (
	userId: typeof mcpOAuthCodes.$inferInsert.userId,
	request: McpAuthorizationRequest,
) => {
	const code = token("cap_mcp_code_");
	await db().transaction(async (tx) => {
		const activated = await tx
			.update(mcpOAuthClients)
			.set({ activatedAt: new Date() })
			.where(eq(mcpOAuthClients.clientId, request.clientId));
		if (affectedRows(activated) !== 1)
			throw new Error("Client registration expired");
		await tx.insert(mcpOAuthCodes).values({
			id: nanoId(),
			userId,
			clientId: request.clientId,
			codeHash: hashAgentSecret(code),
			codeChallenge: request.codeChallenge,
			redirectUri: request.redirectUri,
			resource: request.resource,
			expiresAt: new Date(Date.now() + 5 * 60_000),
		});
	});
	return code;
};

const affectedRows = (result: unknown) => {
	const value = Array.isArray(result) ? result[0] : result;
	return (value as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const mintMcpTokens = async (
	tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
	input: {
		userId: typeof mcpOAuthTokens.$inferInsert.userId;
		clientId: string;
		resource: string;
		familyId: string;
	},
) => {
	const accessToken = token("cap_mcp_");
	const refreshToken = token("cap_mcp_refresh_");
	const now = Date.now();
	await tx.insert(mcpOAuthTokens).values({
		id: nanoId(),
		userId: input.userId,
		clientId: input.clientId,
		familyId: input.familyId,
		resource: input.resource,
		accessHash: hashAgentSecret(accessToken),
		refreshHash: hashAgentSecret(refreshToken),
		accessExpiresAt: new Date(now + accessLifetimeSeconds * 1_000),
		refreshExpiresAt: new Date(now + refreshLifetimeSeconds * 1_000),
	});
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		token_type: "Bearer" as const,
		expires_in: accessLifetimeSeconds,
		scope: "caps:read" as const,
	};
};

export const exchangeMcpCode = async (params: URLSearchParams) => {
	const code = params.get("code");
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const verifier = params.get("code_verifier");
	const resource = params.get("resource");
	if (
		!code ||
		!/^cap_mcp_code_[A-Za-z0-9_-]{43}$/.test(code) ||
		!clientId ||
		!redirectUri ||
		!verifier ||
		!isAgentCodeVerifier(verifier) ||
		resource !== mcpResource()
	)
		return null;
	return db().transaction(async (tx) => {
		const [grant] = await tx
			.select()
			.from(mcpOAuthCodes)
			.where(eq(mcpOAuthCodes.codeHash, hashAgentSecret(code)))
			.limit(1);
		if (
			!grant ||
			grant.clientId !== clientId ||
			grant.redirectUri !== redirectUri ||
			grant.resource !== resource ||
			grant.consumedAt ||
			grant.expiresAt.getTime() <= Date.now() ||
			!verifyAgentCodeChallenge(verifier, grant.codeChallenge)
		)
			return null;
		const now = new Date();
		const consumed = await tx
			.update(mcpOAuthCodes)
			.set({ consumedAt: now })
			.where(
				and(
					eq(mcpOAuthCodes.id, grant.id),
					isNull(mcpOAuthCodes.consumedAt),
					gt(mcpOAuthCodes.expiresAt, now),
				),
			);
		if (affectedRows(consumed) !== 1) return null;
		return mintMcpTokens(tx, {
			userId: grant.userId,
			clientId,
			resource,
			familyId: nanoId(),
		});
	});
};

export const refreshMcpTokens = async (params: URLSearchParams) => {
	const refreshToken = params.get("refresh_token");
	const clientId = params.get("client_id");
	const resource = params.get("resource");
	if (
		!refreshToken ||
		!/^cap_mcp_refresh_[A-Za-z0-9_-]{43}$/.test(refreshToken) ||
		!clientId ||
		resource !== mcpResource()
	)
		return null;
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(mcpOAuthTokens)
			.where(eq(mcpOAuthTokens.refreshHash, hashAgentSecret(refreshToken)))
			.limit(1);
		if (!row || row.clientId !== clientId || row.resource !== resource)
			return null;
		if (row.revokedAt) {
			await tx
				.update(mcpOAuthTokens)
				.set({ revokedAt: new Date() })
				.where(eq(mcpOAuthTokens.familyId, row.familyId));
			return null;
		}
		if (row.refreshExpiresAt.getTime() <= Date.now()) return null;
		const now = new Date();
		const revoked = await tx
			.update(mcpOAuthTokens)
			.set({ revokedAt: now })
			.where(
				and(
					eq(mcpOAuthTokens.id, row.id),
					isNull(mcpOAuthTokens.revokedAt),
					gt(mcpOAuthTokens.refreshExpiresAt, now),
				),
			);
		if (affectedRows(revoked) !== 1) return null;
		return mintMcpTokens(tx, {
			userId: row.userId,
			clientId,
			resource,
			familyId: row.familyId,
		});
	});
};

export const authenticateMcpBearer = async (authorization: string | null) => {
	const match = authorization?.match(/^Bearer (cap_mcp_[A-Za-z0-9_-]{43})$/i);
	if (!match?.[1]) return null;
	const [row] = await db()
		.select({
			userId: mcpOAuthTokens.userId,
			clientId: mcpOAuthTokens.clientId,
			email: users.email,
			accessExpiresAt: mcpOAuthTokens.accessExpiresAt,
			revokedAt: mcpOAuthTokens.revokedAt,
			resource: mcpOAuthTokens.resource,
		})
		.from(mcpOAuthTokens)
		.innerJoin(users, eq(mcpOAuthTokens.userId, users.id))
		.where(eq(mcpOAuthTokens.accessHash, hashAgentSecret(match[1])))
		.limit(1);
	if (
		!row ||
		row.revokedAt ||
		row.accessExpiresAt.getTime() <= Date.now() ||
		row.resource !== mcpResource() ||
		isBlockedAccountEmail(row.email)
	)
		return null;
	return { userId: row.userId, clientId: row.clientId };
};

export const revokeMcpToken = async (tokenValue: string, clientId: string) => {
	const hash = hashAgentSecret(tokenValue);
	const [row] = await db()
		.select({
			familyId: mcpOAuthTokens.familyId,
			clientId: mcpOAuthTokens.clientId,
		})
		.from(mcpOAuthTokens)
		.where(
			/^cap_mcp_refresh_/.test(tokenValue)
				? eq(mcpOAuthTokens.refreshHash, hash)
				: eq(mcpOAuthTokens.accessHash, hash),
		)
		.limit(1);
	if (row?.clientId === clientId) {
		await db()
			.update(mcpOAuthTokens)
			.set({ revokedAt: new Date() })
			.where(eq(mcpOAuthTokens.familyId, row.familyId));
	}
};
