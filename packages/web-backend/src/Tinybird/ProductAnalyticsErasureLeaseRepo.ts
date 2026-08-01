import { randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";

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

export interface ProductAnalyticsErasureLeaseStore {
	claimNew: (
		scope: ProductAnalyticsErasureScope,
	) => Effect.Effect<ProductAnalyticsErasureLease | null, Error>;
	claimRecovery: () => Effect.Effect<
		ProductAnalyticsErasureLease | null,
		Error
	>;
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

export class ProductAnalyticsErasureLeaseRepo extends Effect.Service<ProductAnalyticsErasureLeaseRepo>()(
	"ProductAnalyticsErasureLeaseRepo",
	{
		effect: Effect.gen(function* () {
			const database = yield* Database;

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

			const claimNew: ProductAnalyticsErasureLeaseStore["claimNew"] = (scope) =>
				Effect.gen(function* () {
					const ownerId = randomUUID();
					const requestId = randomUUID();
					const available = Dz.sql`${Db.productAnalyticsErasureLeases.ownerId} IS NULL AND ${Db.productAnalyticsErasureLeases.phase} = 'idle'`;
					yield* database.use((db) =>
						db
							.insert(Db.productAnalyticsErasureLeases)
							.values({
								name: LEASE_NAME,
								ownerId,
								requestId,
								fencingToken: 1,
								leaseExpiresAt: leaseExpiry(),
								phase: "claimed",
								pausedPipes: [],
								userId: scope.userId ?? null,
								organizationId: scope.organizationId ?? null,
								attemptCount: 1,
							})
							.onDuplicateKeyUpdate({
								set: {
									ownerId: Dz.sql`IF(${available}, ${ownerId}, ${Db.productAnalyticsErasureLeases.ownerId})`,
									requestId: Dz.sql`IF(${available}, ${requestId}, ${Db.productAnalyticsErasureLeases.requestId})`,
									fencingToken: Dz.sql`IF(${available}, ${Db.productAnalyticsErasureLeases.fencingToken} + 1, ${Db.productAnalyticsErasureLeases.fencingToken})`,
									leaseExpiresAt: Dz.sql`IF(${available}, ${leaseExpiry()}, ${Db.productAnalyticsErasureLeases.leaseExpiresAt})`,
									phase: Dz.sql`IF(${available}, 'claimed', ${Db.productAnalyticsErasureLeases.phase})`,
									pausedPipes: Dz.sql`IF(${available}, JSON_ARRAY(), ${Db.productAnalyticsErasureLeases.pausedPipes})`,
									userId: Dz.sql`IF(${available}, ${scope.userId ?? null}, ${Db.productAnalyticsErasureLeases.userId})`,
									organizationId: Dz.sql`IF(${available}, ${scope.organizationId ?? null}, ${Db.productAnalyticsErasureLeases.organizationId})`,
									attemptCount: Dz.sql`IF(${available}, ${Db.productAnalyticsErasureLeases.attemptCount} + 1, ${Db.productAnalyticsErasureLeases.attemptCount})`,
									lastErrorCode: Dz.sql`IF(${available}, NULL, ${Db.productAnalyticsErasureLeases.lastErrorCode})`,
									updatedAt: Dz.sql`IF(${available}, CURRENT_TIMESTAMP, ${Db.productAnalyticsErasureLeases.updatedAt})`,
								},
							}),
					);
					return yield* readOwned(ownerId);
				});

			const claimRecovery: ProductAnalyticsErasureLeaseStore["claimRecovery"] =
				() =>
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
