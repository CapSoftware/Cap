import { createHash, randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";
import { productAnalyticsIdentityHash } from "../ProductAnalytics/index.ts";

const LEASE_NAME = "global";
const LEASE_DURATION_MS = 5 * 60 * 1_000;

export type ProductAnalyticsErasurePhase =
	| "claimed"
	| "pausing"
	| "deleting"
	| "rebuilding"
	| "resuming"
	| "failed";

export type ProductAnalyticsErasureScope = {
	userId?: string;
	organizationId?: string;
};

export type ProductAnalyticsErasureLease = {
	ownerId: string;
	requestId: string;
	fencingToken: number;
	phase: ProductAnalyticsErasurePhase;
	pausedPipes: string[];
	scope: ProductAnalyticsErasureScope;
};

export type ProductAnalyticsErasureRequest = {
	id: string;
	ownerId: string;
	scope: ProductAnalyticsErasureScope;
};

export interface ProductAnalyticsErasureLeaseStore {
	enqueueErasureRequest: (
		scope: ProductAnalyticsErasureScope,
	) => Effect.Effect<string, Error>;
	claimErasureRequest: (
		requestId?: string,
	) => Effect.Effect<ProductAnalyticsErasureRequest | null, Error>;
	completeErasureRequest: (requestId: string) => Effect.Effect<void, Error>;
	deferErasureRequest: (
		request: ProductAnalyticsErasureRequest,
		errorCode: "erase_failed" | "lease_unavailable",
	) => Effect.Effect<void, Error>;
	waitForIngestionQuiescence: () => Effect.Effect<void, Error>;
	discardPendingEvents: (
		scope: ProductAnalyticsErasureScope,
		anonymousIds?: readonly string[],
	) => Effect.Effect<string[], Error>;
	claimNew: (
		scope: ProductAnalyticsErasureScope,
		requestId?: string,
	) => Effect.Effect<ProductAnalyticsErasureLease | null, Error>;
	claimRecovery: (
		requestId?: string,
	) => Effect.Effect<ProductAnalyticsErasureLease | null, Error>;
	heartbeat: (
		lease: ProductAnalyticsErasureLease,
	) => Effect.Effect<boolean, Error>;
	advance: (
		lease: ProductAnalyticsErasureLease,
		phase: ProductAnalyticsErasurePhase,
		pausedPipes: readonly string[],
	) => Effect.Effect<boolean, Error>;
	complete: (
		lease: ProductAnalyticsErasureLease,
	) => Effect.Effect<boolean, Error>;
	fail: (
		lease: ProductAnalyticsErasureLease,
		pausedPipes: readonly string[],
		lastErrorCode: "erase_failed" | "resume_failed",
	) => Effect.Effect<boolean, Error>;
}

const affectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const leaseExpiry = () => new Date(Date.now() + LEASE_DURATION_MS);

const erasureScopeHash = (scope: ProductAnalyticsErasureScope) =>
	createHash("sha256")
		.update(`erasure\0${scope.userId ?? ""}\0${scope.organizationId ?? ""}`)
		.digest("hex");

export class ProductAnalyticsErasureLeaseRepo extends Effect.Service<ProductAnalyticsErasureLeaseRepo>()(
	"ProductAnalyticsErasureLeaseRepo",
	{
		effect: Effect.gen(function* () {
			const database = yield* Database;
			const enqueueErasureRequest: ProductAnalyticsErasureLeaseStore["enqueueErasureRequest"] =
				(scope) =>
					database.use(async (db) => {
						if (!scope.userId && !scope.organizationId) {
							throw new Error("Product analytics erasure requires an identity");
						}
						const id = randomUUID();
						const scopeHash = erasureScopeHash(scope);
						await db
							.insert(Db.productAnalyticsErasureRequests)
							.values({
								id,
								scopeHash,
								userId: scope.userId ?? null,
								organizationId: scope.organizationId ?? null,
							})
							.onDuplicateKeyUpdate({
								set: {
									status: Dz.sql`IF(${Db.productAnalyticsErasureRequests.status} = 'dead_letter', 'pending', ${Db.productAnalyticsErasureRequests.status})`,
									nextAttemptAt: Dz.sql`IF(${Db.productAnalyticsErasureRequests.status} = 'dead_letter', CURRENT_TIMESTAMP, ${Db.productAnalyticsErasureRequests.nextAttemptAt})`,
									lastErrorCode: Dz.sql`IF(${Db.productAnalyticsErasureRequests.status} = 'dead_letter', NULL, ${Db.productAnalyticsErasureRequests.lastErrorCode})`,
								},
							});
						const [stored] = await db
							.select({ id: Db.productAnalyticsErasureRequests.id })
							.from(Db.productAnalyticsErasureRequests)
							.where(
								Dz.eq(Db.productAnalyticsErasureRequests.scopeHash, scopeHash),
							)
							.limit(1);
						if (!stored) throw new Error("Erasure request was not persisted");
						return stored.id;
					});

			const claimErasureRequest: ProductAnalyticsErasureLeaseStore["claimErasureRequest"] =
				(requestId) =>
					Effect.gen(function* () {
						const ownerId = randomUUID();
						return yield* database.use((db) =>
							db.transaction(async (tx) => {
								const now = new Date();
								const [request] = await tx
									.select({
										id: Db.productAnalyticsErasureRequests.id,
										userId: Db.productAnalyticsErasureRequests.userId,
										organizationId:
											Db.productAnalyticsErasureRequests.organizationId,
									})
									.from(Db.productAnalyticsErasureRequests)
									.where(
										Dz.and(
											requestId
												? Dz.eq(
														Db.productAnalyticsErasureRequests.id,
														requestId,
													)
												: undefined,
											Dz.or(
												Dz.and(
													Dz.eq(
														Db.productAnalyticsErasureRequests.status,
														"pending",
													),
													requestId
														? undefined
														: Dz.lte(
																Db.productAnalyticsErasureRequests
																	.nextAttemptAt,
																now,
															),
												),
												Dz.and(
													Dz.eq(
														Db.productAnalyticsErasureRequests.status,
														"processing",
													),
													Dz.or(
														Dz.isNull(
															Db.productAnalyticsErasureRequests.leaseExpiresAt,
														),
														Dz.lte(
															Db.productAnalyticsErasureRequests.leaseExpiresAt,
															now,
														),
													),
												),
											),
										),
									)
									.orderBy(Dz.asc(Db.productAnalyticsErasureRequests.createdAt))
									.limit(1)
									.for("update", { skipLocked: true });
								if (!request) return null;
								await tx
									.update(Db.productAnalyticsErasureRequests)
									.set({
										status: "processing",
										attemptCount: Dz.sql`${Db.productAnalyticsErasureRequests.attemptCount} + 1`,
										leaseOwnerId: ownerId,
										leaseExpiresAt: leaseExpiry(),
										lastErrorCode: null,
									})
									.where(
										Dz.eq(Db.productAnalyticsErasureRequests.id, request.id),
									);
								return {
									id: request.id,
									ownerId,
									scope: {
										userId: request.userId ?? undefined,
										organizationId: request.organizationId ?? undefined,
									},
								};
							}),
						);
					});

			const completeErasureRequest: ProductAnalyticsErasureLeaseStore["completeErasureRequest"] =
				(requestId) =>
					database
						.use((db) =>
							db
								.delete(Db.productAnalyticsErasureRequests)
								.where(Dz.eq(Db.productAnalyticsErasureRequests.id, requestId)),
						)
						.pipe(Effect.asVoid);

			const deferErasureRequest: ProductAnalyticsErasureLeaseStore["deferErasureRequest"] =
				(request, errorCode) =>
					database
						.use((db) =>
							db
								.update(Db.productAnalyticsErasureRequests)
								.set({
									status: "pending",
									nextAttemptAt: new Date(Date.now() + 30_000),
									leaseOwnerId: null,
									leaseExpiresAt: null,
									lastErrorCode: errorCode,
								})
								.where(
									Dz.and(
										Dz.eq(Db.productAnalyticsErasureRequests.id, request.id),
										Dz.eq(
											Db.productAnalyticsErasureRequests.leaseOwnerId,
											request.ownerId,
										),
									),
								),
						)
						.pipe(Effect.asVoid);
			const waitForIngestionQuiescence: ProductAnalyticsErasureLeaseStore["waitForIngestionQuiescence"] =
				() =>
					Effect.gen(function* () {
						for (let attempt = 0; attempt < 300; attempt += 1) {
							const active = yield* database.use(async (db) => {
								const now = new Date();
								await db
									.delete(Db.productAnalyticsIngestionLeases)
									.where(
										Dz.lte(Db.productAnalyticsIngestionLeases.expiresAt, now),
									);
								const [row] = await db
									.select({ count: Dz.count() })
									.from(Db.productAnalyticsIngestionLeases)
									.where(
										Dz.gt(Db.productAnalyticsIngestionLeases.expiresAt, now),
									);
								return Number(row?.count ?? 0);
							});
							if (active === 0) return;
							yield* Effect.sleep(1_000);
						}
						return yield* Effect.fail(
							new Error("Product analytics ingestion did not quiesce"),
						);
					});
			const discardPendingEvents: ProductAnalyticsErasureLeaseStore["discardPendingEvents"] =
				(scope, anonymousIds = []) =>
					database.use((db) =>
						db.transaction(async (tx) => {
							const userIdentityHash = scope.userId
								? productAnalyticsIdentityHash("user", scope.userId)
								: undefined;
							const organizationIdentityHash = scope.organizationId
								? productAnalyticsIdentityHash(
										"organization",
										scope.organizationId,
									)
								: undefined;
							const linkedAliases = userIdentityHash
								? await tx
										.select({
											anonymousId: Db.productAnalyticsIdentityLinks.anonymousId,
										})
										.from(Db.productAnalyticsIdentityLinks)
										.where(
											Dz.eq(
												Db.productAnalyticsIdentityLinks.userIdentityHash,
												userIdentityHash,
											),
										)
										.for("update")
								: [];
							const localAliases = scope.userId
								? await tx
										.select({
											anonymousId: Db.productAnalyticsOutbox.anonymousId,
										})
										.from(Db.productAnalyticsOutbox)
										.where(
											Dz.eq(Db.productAnalyticsOutbox.userId, scope.userId),
										)
								: [];
							const candidateAliases = [
								...new Set([
									...anonymousIds,
									...linkedAliases.map(({ anonymousId }) => anonymousId),
									...localAliases.flatMap(({ anonymousId }) =>
										anonymousId ? [anonymousId] : [],
									),
								]),
							];
							const candidateAliasHashes = candidateAliases.map((anonymousId) =>
								productAnalyticsIdentityHash("anonymous", anonymousId),
							);
							const sharedLinkedAliases =
								userIdentityHash && candidateAliasHashes.length > 0
									? await tx
											.select({
												anonymousIdentityHash:
													Db.productAnalyticsIdentityLinks
														.anonymousIdentityHash,
											})
											.from(Db.productAnalyticsIdentityLinks)
											.where(
												Dz.and(
													Dz.inArray(
														Db.productAnalyticsIdentityLinks
															.anonymousIdentityHash,
														candidateAliasHashes,
													),
													Dz.ne(
														Db.productAnalyticsIdentityLinks.userIdentityHash,
														userIdentityHash,
													),
												),
											)
											.for("update")
									: [];
							const sharedAliases =
								scope.userId && candidateAliases.length > 0
									? await tx
											.select({
												anonymousId: Db.productAnalyticsOutbox.anonymousId,
											})
											.from(Db.productAnalyticsOutbox)
											.where(
												Dz.and(
													Dz.inArray(
														Db.productAnalyticsOutbox.anonymousId,
														candidateAliases,
													),
													Dz.isNotNull(Db.productAnalyticsOutbox.userId),
													Dz.ne(Db.productAnalyticsOutbox.userId, scope.userId),
												),
											)
											.for("update")
									: [];
							const sharedAliasSet = new Set(
								sharedAliases.flatMap(({ anonymousId }) =>
									anonymousId ? [anonymousId] : [],
								),
							);
							const sharedLinkedAliasHashes = new Set(
								sharedLinkedAliases.map(
									({ anonymousIdentityHash }) => anonymousIdentityHash,
								),
							);
							const aliases = candidateAliases.filter(
								(anonymousId) =>
									!sharedAliasSet.has(anonymousId) &&
									!sharedLinkedAliasHashes.has(
										productAnalyticsIdentityHash("anonymous", anonymousId),
									),
							);
							const anonymousIdentityHashes = aliases.map((anonymousId) =>
								productAnalyticsIdentityHash("anonymous", anonymousId),
							);
							const conditions = [
								scope.userId
									? Dz.eq(Db.productAnalyticsOutbox.userId, scope.userId)
									: undefined,
								scope.organizationId
									? Dz.eq(
											Db.productAnalyticsOutbox.organizationId,
											scope.organizationId,
										)
									: undefined,
								aliases.length > 0 && scope.userId
									? Dz.and(
											Dz.inArray(
												Db.productAnalyticsOutbox.anonymousId,
												aliases,
											),
											Dz.or(
												Dz.isNull(Db.productAnalyticsOutbox.userId),
												Dz.eq(Db.productAnalyticsOutbox.userId, scope.userId),
											),
										)
									: undefined,
							].filter((condition) => condition !== undefined);
							if (conditions.length === 0) {
								throw new Error(
									"Product analytics erasure requires an identity",
								);
							}
							const states = [
								scope.userId
									? {
											identityHash: productAnalyticsIdentityHash(
												"user",
												scope.userId,
											),
											identityKind: "user" as const,
										}
									: undefined,
								scope.organizationId
									? {
											identityHash: productAnalyticsIdentityHash(
												"organization",
												scope.organizationId,
											),
											identityKind: "organization" as const,
										}
									: undefined,
								...aliases.map((anonymousId) => ({
									identityHash: productAnalyticsIdentityHash(
										"anonymous",
										anonymousId,
									),
									identityKind: "anonymous" as const,
								})),
							]
								.filter((state) => state !== undefined)
								.sort((left, right) =>
									left.identityHash.localeCompare(right.identityHash),
								);
							const blockedAt = new Date();
							await tx
								.insert(Db.productAnalyticsIdentityState)
								.values(states.map((state) => ({ ...state, blockedAt })))
								.onDuplicateKeyUpdate({ set: { blockedAt } });
							await tx
								.delete(Db.productAnalyticsOutbox)
								.where(Dz.or(...conditions));
							const receiptConditions = [
								userIdentityHash
									? Dz.eq(
											Db.productAnalyticsEventReceipts.userIdentityHash,
											userIdentityHash,
										)
									: undefined,
								organizationIdentityHash
									? Dz.eq(
											Db.productAnalyticsEventReceipts.organizationIdentityHash,
											organizationIdentityHash,
										)
									: undefined,
								anonymousIdentityHashes.length > 0 && userIdentityHash
									? Dz.and(
											Dz.inArray(
												Db.productAnalyticsEventReceipts.anonymousIdentityHash,
												anonymousIdentityHashes,
											),
											Dz.or(
												Dz.isNull(
													Db.productAnalyticsEventReceipts.userIdentityHash,
												),
												Dz.eq(
													Db.productAnalyticsEventReceipts.userIdentityHash,
													userIdentityHash,
												),
											),
										)
									: undefined,
							].filter((condition) => condition !== undefined);
							if (receiptConditions.length > 0) {
								await tx
									.delete(Db.productAnalyticsEventReceipts)
									.where(Dz.or(...receiptConditions));
							}
							if (organizationIdentityHash) {
								await tx
									.update(Db.productAnalyticsIdentityLinks)
									.set({ organizationIdentityHash: null })
									.where(
										Dz.eq(
											Db.productAnalyticsIdentityLinks.organizationIdentityHash,
											organizationIdentityHash,
										),
									);
							}
							if (userIdentityHash) {
								await tx
									.delete(Db.productAnalyticsIdentityLinks)
									.where(
										Dz.eq(
											Db.productAnalyticsIdentityLinks.userIdentityHash,
											userIdentityHash,
										),
									);
							}
							const [remaining] = await tx
								.select({ count: Dz.count() })
								.from(Db.productAnalyticsOutbox)
								.where(Dz.or(...conditions));
							if (Number(remaining?.count ?? 0) !== 0) {
								throw new Error(
									"Product analytics outbox erasure was incomplete",
								);
							}
							if (organizationIdentityHash) {
								const [remainingLinks] = await tx
									.select({ count: Dz.count() })
									.from(Db.productAnalyticsIdentityLinks)
									.where(
										Dz.eq(
											Db.productAnalyticsIdentityLinks.organizationIdentityHash,
											organizationIdentityHash,
										),
									);
								if (Number(remainingLinks?.count ?? 0) !== 0) {
									throw new Error(
										"Product analytics identity-link erasure was incomplete",
									);
								}
							}
							return aliases;
						}),
					);

			const readOwned = (ownerId: string) =>
				database.use(async (db) => {
					const [row] = await db
						.select()
						.from(Db.productAnalyticsErasureLeases)
						.where(
							Dz.and(
								Dz.eq(Db.productAnalyticsErasureLeases.name, LEASE_NAME),
								Dz.eq(Db.productAnalyticsErasureLeases.ownerId, ownerId),
							),
						)
						.limit(1);
					if (
						!row?.ownerId ||
						!row.requestId ||
						row.phase === "idle" ||
						!Number.isSafeInteger(row.fencingToken)
					) {
						return null;
					}
					return {
						ownerId: row.ownerId,
						requestId: row.requestId,
						fencingToken: row.fencingToken,
						phase: row.phase as ProductAnalyticsErasurePhase,
						pausedPipes: Array.isArray(row.pausedPipes)
							? row.pausedPipes.filter(
									(value): value is string => typeof value === "string",
								)
							: [],
						scope: {
							userId: row.userId ?? undefined,
							organizationId: row.organizationId ?? undefined,
						},
					} satisfies ProductAnalyticsErasureLease;
				});

			const claimNew: ProductAnalyticsErasureLeaseStore["claimNew"] = (
				scope,
				queuedRequestId,
			) =>
				Effect.gen(function* () {
					const ownerId = randomUUID();
					const requestId = queuedRequestId ?? randomUUID();
					const claimed = yield* database.use((db) =>
						db.transaction(async (tx) => {
							await tx
								.insert(Db.productAnalyticsErasureLeases)
								.values({ name: LEASE_NAME })
								.onDuplicateKeyUpdate({ set: { name: LEASE_NAME } });
							const result = await tx
								.update(Db.productAnalyticsErasureLeases)
								.set({
									ownerId,
									requestId,
									fencingToken: Dz.sql`${Db.productAnalyticsErasureLeases.fencingToken} + 1`,
									leaseExpiresAt: leaseExpiry(),
									phase: "claimed",
									pausedPipes: [],
									userId: scope.userId ?? null,
									organizationId: scope.organizationId ?? null,
									attemptCount: Dz.sql`${Db.productAnalyticsErasureLeases.attemptCount} + 1`,
									lastErrorCode: null,
									updatedAt: new Date(),
								})
								.where(
									Dz.and(
										Dz.eq(Db.productAnalyticsErasureLeases.name, LEASE_NAME),
										Dz.isNull(Db.productAnalyticsErasureLeases.ownerId),
										Dz.eq(Db.productAnalyticsErasureLeases.phase, "idle"),
									),
								);
							return affectedRows(result) > 0;
						}),
					);
					if (!claimed) return null;
					return yield* readOwned(ownerId);
				});

			const claimRecovery: ProductAnalyticsErasureLeaseStore["claimRecovery"] =
				(requestId) =>
					Effect.gen(function* () {
						const ownerId = randomUUID();
						const result = yield* database.use((db) =>
							db
								.update(Db.productAnalyticsErasureLeases)
								.set({
									ownerId,
									fencingToken: Dz.sql`${Db.productAnalyticsErasureLeases.fencingToken} + 1`,
									leaseExpiresAt: leaseExpiry(),
									attemptCount: Dz.sql`${Db.productAnalyticsErasureLeases.attemptCount} + 1`,
									updatedAt: new Date(),
								})
								.where(
									Dz.and(
										Dz.eq(Db.productAnalyticsErasureLeases.name, LEASE_NAME),
										requestId
											? Dz.eq(
													Db.productAnalyticsErasureLeases.requestId,
													requestId,
												)
											: undefined,
										Dz.ne(Db.productAnalyticsErasureLeases.phase, "idle"),
										Dz.or(
											Dz.isNull(Db.productAnalyticsErasureLeases.ownerId),
											Dz.isNull(
												Db.productAnalyticsErasureLeases.leaseExpiresAt,
											),
											Dz.sql`${Db.productAnalyticsErasureLeases.leaseExpiresAt} < CURRENT_TIMESTAMP`,
										),
									),
								),
						);
						if (affectedRows(result) === 0) return null;
						return yield* readOwned(ownerId);
					});

			const ownedFence = (lease: ProductAnalyticsErasureLease) =>
				Dz.and(
					Dz.eq(Db.productAnalyticsErasureLeases.name, LEASE_NAME),
					Dz.eq(Db.productAnalyticsErasureLeases.ownerId, lease.ownerId),
					Dz.eq(
						Db.productAnalyticsErasureLeases.fencingToken,
						lease.fencingToken,
					),
				);

			const heartbeat: ProductAnalyticsErasureLeaseStore["heartbeat"] = (
				lease,
			) =>
				Effect.gen(function* () {
					const result = yield* database.use((db) =>
						db
							.update(Db.productAnalyticsErasureLeases)
							.set({ leaseExpiresAt: leaseExpiry(), updatedAt: new Date() })
							.where(ownedFence(lease)),
					);
					if (affectedRows(result) > 0) return true;
					return Boolean(yield* readOwned(lease.ownerId));
				});

			const advance: ProductAnalyticsErasureLeaseStore["advance"] = (
				lease,
				phase,
				pausedPipes,
			) =>
				Effect.gen(function* () {
					const result = yield* database.use((db) =>
						db
							.update(Db.productAnalyticsErasureLeases)
							.set({
								phase,
								pausedPipes: [...pausedPipes],
								leaseExpiresAt: leaseExpiry(),
								updatedAt: new Date(),
							})
							.where(ownedFence(lease)),
					);
					if (affectedRows(result) > 0) return true;
					return Boolean(yield* readOwned(lease.ownerId));
				});

			const complete: ProductAnalyticsErasureLeaseStore["complete"] = (lease) =>
				database.use(async (db) => {
					const result = await db
						.update(Db.productAnalyticsErasureLeases)
						.set({
							ownerId: null,
							requestId: null,
							leaseExpiresAt: null,
							phase: "idle",
							pausedPipes: [],
							userId: null,
							organizationId: null,
							lastErrorCode: null,
							updatedAt: new Date(),
						})
						.where(ownedFence(lease));
					return affectedRows(result) > 0;
				});

			const fail: ProductAnalyticsErasureLeaseStore["fail"] = (
				lease,
				pausedPipes,
				lastErrorCode,
			) =>
				database.use(async (db) => {
					const result = await db
						.update(Db.productAnalyticsErasureLeases)
						.set({
							ownerId: null,
							leaseExpiresAt: null,
							phase: "failed",
							pausedPipes: [...pausedPipes],
							lastErrorCode,
							updatedAt: new Date(),
						})
						.where(ownedFence(lease));
					return affectedRows(result) > 0;
				});

			return {
				enqueueErasureRequest,
				claimErasureRequest,
				completeErasureRequest,
				deferErasureRequest,
				waitForIngestionQuiescence,
				discardPendingEvents,
				claimNew,
				claimRecovery,
				heartbeat,
				advance,
				complete,
				fail,
			} satisfies ProductAnalyticsErasureLeaseStore;
		}),
		dependencies: [Database.Default],
	},
) {}
