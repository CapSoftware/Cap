import { createHash } from "node:crypto";
import * as Db from "@cap/database/schema";
import { Agent } from "@cap/web-domain";
import { HttpServerRequest } from "@effect/platform";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { Database } from "./Database.ts";

const requestId = () => crypto.randomUUID();

const authRequired = () =>
	new Agent.AgentAuthenticationError({
		code: "AUTH_REQUIRED",
		message: "A valid Cap credential is required",
		retryable: false,
		retryAfterMs: null,
		requestId: requestId(),
	});

const tokenExpired = () =>
	new Agent.AgentAuthenticationError({
		code: "TOKEN_EXPIRED",
		message: "The Cap CLI credential has expired or been revoked",
		retryable: false,
		retryAfterMs: null,
		requestId: requestId(),
	});

const temporarilyUnavailable = () =>
	new Agent.AgentTemporaryUnavailableError({
		code: "TEMPORARY_UNAVAILABLE",
		message: "Authentication is temporarily unavailable",
		retryable: true,
		retryAfterMs: null,
		requestId: requestId(),
	});

const parseBearerToken = (authorization: string | undefined) => {
	if (!authorization) return null;
	const [scheme, token, extra] = authorization.trim().split(/\s+/);
	if (scheme?.toLowerCase() !== "bearer" || !token || extra) return null;
	return token;
};

const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("hex");

const agentLastUsedRefreshMs = 5 * 60 * 1000;

export const shouldRefreshAgentLastUsedAt = (
	lastUsedAt: Date | null,
	now: Date,
) =>
	lastUsedAt === null ||
	now.getTime() - lastUsedAt.getTime() >= agentLastUsedRefreshMs;

const agentScopes = new Set<Agent.AgentScope>([
	"caps:read",
	"caps:comment",
	"caps:write",
	"profile:read",
	"profile:write",
	"caps:upload",
	"caps:process",
	"caps:delete",
	"library:read",
	"library:write",
	"analytics:read",
	"organizations:read",
	"organizations:manage",
	"organizations:members",
	"notifications:read",
	"notifications:write",
	"integrations:read",
	"integrations:write",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
]);

const parseScopes = (value: unknown) => {
	if (!Array.isArray(value)) return null;
	const scopes = value.filter(
		(scope): scope is Agent.AgentScope =>
			typeof scope === "string" && agentScopes.has(scope as Agent.AgentScope),
	);
	return scopes.length === value.length && scopes.includes("caps:read")
		? new Set(scopes)
		: null;
};

export const isLegacyAgentKeySource = (source: string) =>
	source === "desktop" || source === "unknown";

export const AgentHttpAuthMiddlewareLive = Layer.effect(
	Agent.AgentHttpAuthMiddleware,
	Effect.gen(function* () {
		const database = yield* Database;

		return Agent.AgentHttpAuthMiddleware.of(
			Effect.gen(function* () {
				const headers = yield* HttpServerRequest.schemaHeaders(
					Schema.Struct({ authorization: Schema.optional(Schema.String) }),
				);
				const token = parseBearerToken(headers.authorization);
				if (!token) return yield* authRequired();

				if (/^cap_cli_[A-Za-z0-9_-]{43}$/.test(token)) {
					const [row] = yield* database.use((db) =>
						db
							.select({
								tokenId: Db.agentApiKeys.id,
								scopes: Db.agentApiKeys.scopes,
								expiresAt: Db.agentApiKeys.expiresAt,
								revokedAt: Db.agentApiKeys.revokedAt,
								lastUsedAt: Db.agentApiKeys.lastUsedAt,
								id: Db.users.id,
								email: Db.users.email,
								activeOrganizationId: Db.users.activeOrganizationId,
							})
							.from(Db.agentApiKeys)
							.innerJoin(Db.users, eq(Db.agentApiKeys.userId, Db.users.id))
							.where(eq(Db.agentApiKeys.tokenHash, hashToken(token)))
							.limit(1),
					);
					if (!row) return yield* authRequired();
					if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
						return yield* tokenExpired();
					}
					const scopes = parseScopes(row.scopes);
					if (!scopes) return yield* authRequired();
					const now = new Date();
					if (shouldRefreshAgentLastUsedAt(row.lastUsedAt, now)) {
						yield* database
							.use((db) =>
								db
									.update(Db.agentApiKeys)
									.set({ lastUsedAt: now })
									.where(
										and(
											eq(Db.agentApiKeys.id, row.tokenId),
											or(
												isNull(Db.agentApiKeys.lastUsedAt),
												lte(
													Db.agentApiKeys.lastUsedAt,
													new Date(now.getTime() - agentLastUsedRefreshMs),
												),
											),
										),
									),
							)
							.pipe(Effect.catchAll(() => Effect.void));
					}
					return Agent.AgentPrincipal.of({
						id: row.id,
						email: row.email,
						activeOrganizationId: row.activeOrganizationId,
						scopes,
						tokenId: row.tokenId,
						tokenKind: "agent",
						expiresAt: row.expiresAt,
					});
				}

				if (token.length !== 36) return yield* authRequired();

				const [row] = yield* database.use((db) =>
					db
						.select({
							id: Db.users.id,
							email: Db.users.email,
							activeOrganizationId: Db.users.activeOrganizationId,
							source: Db.authApiKeys.source,
						})
						.from(Db.authApiKeys)
						.innerJoin(Db.users, eq(Db.authApiKeys.userId, Db.users.id))
						.where(eq(Db.authApiKeys.id, token))
						.limit(1),
				);
				if (!row) return yield* authRequired();
				if (!isLegacyAgentKeySource(row.source)) return yield* authRequired();

				return Agent.AgentPrincipal.of({
					id: row.id,
					email: row.email,
					activeOrganizationId: row.activeOrganizationId,
					scopes: new Set<Agent.AgentScope>([
						"caps:read",
						"caps:comment",
						"caps:write",
					]),
					tokenId: token,
					tokenKind: "legacy",
					expiresAt: null,
				});
			}).pipe(
				Effect.provideService(Database, database),
				Effect.catchTags({
					DatabaseError: () => Effect.fail(temporarilyUnavailable()),
					ParseError: () => Effect.fail(authRequired()),
				}),
			),
		);
	}),
);

export const parseAgentBearerToken = parseBearerToken;
