import { randomUUID } from "node:crypto";
import {
	PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
	ProductAnalyticsError,
	type ProductEventRow,
	productAnalyticsEventIdHash,
	productAnalyticsIdentityHash,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { DatabaseError } from "@cap/web-domain";
import { HttpServerRequest } from "@effect/platform";
import * as Dz from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { getCurrentUser } from "../Auth.ts";
import { Database } from "../Database.ts";

export {
	ProductAnalyticsError,
	sendProductAnalyticsRows,
} from "@cap/analytics";

export interface ProductAnalyticsActor {
	userId: string;
	organizationId: string;
}

export type { ProductAnalyticsIdentityKind } from "@cap/analytics";
export {
	productAnalyticsEventIdHash,
	productAnalyticsIdentityHash,
} from "@cap/analytics";

function productAnalyticsRowIdentities(rows: readonly ProductEventRow[]) {
	return [
		...new Map(
			rows
				.flatMap((row) => [
					row.anonymous_id
						? {
								identityHash: productAnalyticsIdentityHash(
									"anonymous",
									row.anonymous_id,
								),
								identityKind: "anonymous" as const,
							}
						: undefined,
					row.user_id
						? {
								identityHash: productAnalyticsIdentityHash("user", row.user_id),
								identityKind: "user" as const,
							}
						: undefined,
					row.organization_id
						? {
								identityHash: productAnalyticsIdentityHash(
									"organization",
									row.organization_id,
								),
								identityKind: "organization" as const,
							}
						: undefined,
				])
				.filter((identity) => identity !== undefined)
				.map((identity) => [identity.identityHash, identity]),
		).values(),
	].sort((left, right) => left.identityHash.localeCompare(right.identityHash));
}

type VercelEnvironment = "production" | "preview" | "development";

const PRODUCT_ANALYTICS_INGESTION_LEASE_MS = 5 * 60 * 1_000;
const PRODUCT_ANALYTICS_RECEIPT_RETENTION_MS = 800 * 24 * 60 * 60 * 1_000;

interface ProductAnalyticsServiceOptions {
	host?: string;
	token?: string;
	required: boolean;
	sendRows?: typeof sendProductAnalyticsRows;
}

export function isOfficialProductAnalyticsDeployment({
	isCap,
	vercelEnvironment,
}: {
	isCap?: string;
	vercelEnvironment?: VercelEnvironment;
}) {
	return (
		isCap === "true" &&
		(vercelEnvironment === "production" || vercelEnvironment === "preview")
	);
}

export function createProductAnalyticsService({
	host: rawHost,
	token: rawToken,
	required,
	sendRows = sendProductAnalyticsRows,
}: ProductAnalyticsServiceOptions) {
	const host = rawHost?.trim() || undefined;
	const token = rawToken?.trim() || undefined;
	const enabled = Boolean(host && token);

	const append = (rows: readonly ProductEventRow[], wait = false) => {
		if (rows.length === 0) return Effect.void;
		if (!enabled || !host || !token) {
			return required
				? Effect.fail(
						new ProductAnalyticsError({
							cause: "Product analytics Tinybird configuration is incomplete",
							retryable: true,
							status: 503,
						}),
					)
				: Effect.void;
		}

		return Effect.tryPromise({
			try: () =>
				sendRows({
					host,
					token,
					rows,
					wait,
					maxAttempts: 1,
				}),
			catch: (cause) =>
				cause instanceof ProductAnalyticsError
					? cause
					: new ProductAnalyticsError({ cause, retryable: false }),
		});
	};

	return { enabled, append } as const;
}

export function hasAnalyticsSessionCookie(cookie?: string) {
	return /(?:^|;\s*)next-auth\.session-token(?:\.\d+)?=/.test(cookie ?? "");
}

export const resolveProductAnalyticsActor = Effect.gen(function* () {
	const database = yield* Database;
	const headers = yield* HttpServerRequest.schemaHeaders(
		Schema.Struct({
			authorization: Schema.optional(Schema.String),
			cookie: Schema.optional(Schema.String),
		}),
	).pipe(
		Effect.catchAll(() =>
			Effect.succeed({ authorization: undefined, cookie: undefined }),
		),
	);
	const token = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

	const user =
		token?.length === 36
			? yield* database
					.use((db) =>
						db
							.select({
								id: Db.users.id,
								activeOrganizationId: Db.users.activeOrganizationId,
							})
							.from(Db.users)
							.innerJoin(
								Db.authApiKeys,
								Dz.eq(Db.users.id, Db.authApiKeys.userId),
							)
							.where(Dz.eq(Db.authApiKeys.id, token))
							.limit(1),
					)
					.pipe(Effect.map(([entry]) => Option.fromNullable(entry)))
			: hasAnalyticsSessionCookie(headers.cookie)
				? yield* getCurrentUser.pipe(
						Effect.map(
							Option.map((entry) => ({
								id: entry.id,
								activeOrganizationId: entry.activeOrganizationId,
							})),
						),
					)
				: Option.none();

	if (Option.isNone(user)) return undefined;
	const [actor] = yield* database.use((db) => {
		const pendingDeletionUserIds = db
			.select({ userId: Db.messengerSupportEmails.userId })
			.from(Db.messengerSupportEmails)
			.where(
				Dz.eq(
					Db.messengerSupportEmails.subject,
					PRODUCT_ANALYTICS_ACCOUNT_DELETION_PENDING_SUBJECT,
				),
			);
		return db
			.select({
				userId: Db.users.id,
				organizationId: Db.organizations.id,
			})
			.from(Db.users)
			.innerJoin(
				Db.organizations,
				Dz.eq(Db.users.activeOrganizationId, Db.organizations.id),
			)
			.where(
				Dz.and(
					Dz.eq(Db.users.id, user.value.id),
					Dz.isNull(Db.organizations.tombstoneAt),
					Dz.notInArray(Db.users.id, pendingDeletionUserIds),
				),
			)
			.limit(1);
	});
	return actor satisfies ProductAnalyticsActor | undefined;
}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export class ProductAnalytics extends Effect.Service<ProductAnalytics>()(
	"ProductAnalytics",
	{
		effect: Effect.gen(function* () {
			const database = yield* Database;
			const env = serverEnv();
			const service = createProductAnalyticsService({
				host: env.PRODUCT_ANALYTICS_TINYBIRD_HOST,
				token: env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
				required: isOfficialProductAnalyticsDeployment({
					isCap: process.env.NEXT_PUBLIC_IS_CAP,
					vercelEnvironment: env.VERCEL_ENV,
				}),
			});
			const appendWithIdentityFence = (
				rows: readonly ProductEventRow[],
			): Effect.Effect<
				{
					acceptedEventIds: string[];
					rejectedEventIds: string[];
				},
				ProductAnalyticsError | DatabaseError
			> => {
				const identities = productAnalyticsRowIdentities(rows);
				return database
					.use(async (db) => {
						await db
							.insert(Db.productAnalyticsErasureLeases)
							.values({ name: "global" })
							.onDuplicateKeyUpdate({ set: { name: "global" } });
						const [fence] = await db
							.select({
								fencingToken: Db.productAnalyticsErasureLeases.fencingToken,
								phase: Db.productAnalyticsErasureLeases.phase,
							})
							.from(Db.productAnalyticsErasureLeases)
							.where(Dz.eq(Db.productAnalyticsErasureLeases.name, "global"))
							.limit(1);
						if (!fence || fence.phase !== "idle") {
							throw new Error("Product analytics erasure is in progress");
						}
						const leaseId = randomUUID();
						await db.insert(Db.productAnalyticsIngestionLeases).values({
							id: leaseId,
							fencingToken: fence.fencingToken,
							expiresAt: new Date(
								Date.now() + PRODUCT_ANALYTICS_INGESTION_LEASE_MS,
							),
						});
						const [confirmed] = await db
							.select({
								fencingToken: Db.productAnalyticsErasureLeases.fencingToken,
								phase: Db.productAnalyticsErasureLeases.phase,
							})
							.from(Db.productAnalyticsErasureLeases)
							.where(Dz.eq(Db.productAnalyticsErasureLeases.name, "global"))
							.limit(1);
						if (
							!confirmed ||
							confirmed.phase !== "idle" ||
							confirmed.fencingToken !== fence.fencingToken
						) {
							await db
								.delete(Db.productAnalyticsIngestionLeases)
								.where(Dz.eq(Db.productAnalyticsIngestionLeases.id, leaseId));
							throw new Error("Product analytics erasure fence changed");
						}
						return leaseId;
					})
					.pipe(
						Effect.flatMap((leaseId) =>
							database
								.use((db) =>
									db.transaction(async (tx) => {
										await tx
											.insert(Db.productAnalyticsIdentityState)
											.values(identities)
											.onDuplicateKeyUpdate({
												set: {
													identityHash: Dz.sql`${Db.productAnalyticsIdentityState.identityHash}`,
												},
											});
										const states = await tx
											.select({
												blockedAt: Db.productAnalyticsIdentityState.blockedAt,
												identityKind:
													Db.productAnalyticsIdentityState.identityKind,
											})
											.from(Db.productAnalyticsIdentityState)
											.where(
												Dz.inArray(
													Db.productAnalyticsIdentityState.identityHash,
													identities.map((identity) => identity.identityHash),
												),
											)
											.for("update");
										const blockedAt = states.find(
											(state) => state.blockedAt !== null,
										)?.blockedAt;
										if (blockedAt) {
											const blockedPrincipal = states.some(
												(state) =>
													state.blockedAt !== null &&
													state.identityKind !== "anonymous",
											);
											const anonymousHashes = identities
												.filter(
													(identity) => identity.identityKind === "anonymous",
												)
												.map((identity) => identity.identityHash);
											if (blockedPrincipal && anonymousHashes.length > 0) {
												await tx
													.update(Db.productAnalyticsIdentityState)
													.set({ blockedAt })
													.where(
														Dz.inArray(
															Db.productAnalyticsIdentityState.identityHash,
															anonymousHashes,
														),
													);
											}
											return {
												acceptedEventIds: [],
												rejectedEventIds: rows.map((row) => row.event_id),
												rows: [] as ProductEventRow[],
											};
										}
										const anonymousIdentity = identities.find(
											(identity) => identity.identityKind === "anonymous",
										);
										const userIdentity = identities.find(
											(identity) => identity.identityKind === "user",
										);
										const organizationIdentity = identities.find(
											(identity) => identity.identityKind === "organization",
										);
										const anonymousId = rows.find(
											(row) => row.anonymous_id,
										)?.anonymous_id;
										if (anonymousIdentity && userIdentity && anonymousId) {
											await tx
												.insert(Db.productAnalyticsIdentityLinks)
												.values({
													anonymousIdentityHash: anonymousIdentity.identityHash,
													userIdentityHash: userIdentity.identityHash,
													organizationIdentityHash:
														organizationIdentity?.identityHash ?? null,
													anonymousId,
												})
												.onDuplicateKeyUpdate({
													set: {
														organizationIdentityHash:
															organizationIdentity?.identityHash ?? null,
														updatedAt: new Date(),
													},
												});
										}
										const now = new Date();
										const retainUntil = new Date(
											now.getTime() + PRODUCT_ANALYTICS_RECEIPT_RETENTION_MS,
										);
										const admittedRows: ProductEventRow[] = [];
										const rejectedEventIds: string[] = [];
										for (const row of rows) {
											const eventIdHash = productAnalyticsEventIdHash(
												row.event_id,
											);
											const anonymousIdentityHash = row.anonymous_id
												? productAnalyticsIdentityHash(
														"anonymous",
														row.anonymous_id,
													)
												: null;
											const userIdentityHash = row.user_id
												? productAnalyticsIdentityHash("user", row.user_id)
												: null;
											const organizationIdentityHash = row.organization_id
												? productAnalyticsIdentityHash(
														"organization",
														row.organization_id,
													)
												: null;
											await tx
												.insert(Db.productAnalyticsEventReceipts)
												.values({
													eventIdHash,
													payloadHash: row.payload_hash,
													anonymousIdentityHash,
													userIdentityHash,
													organizationIdentityHash,
													retainUntil,
												})
												.onDuplicateKeyUpdate({
													set: {
														conflictCount: Dz.sql`IF(${Db.productAnalyticsEventReceipts.payloadHash} <> ${row.payload_hash}, ${Db.productAnalyticsEventReceipts.conflictCount} + 1, ${Db.productAnalyticsEventReceipts.conflictCount})`,
														lastSeenAt: now,
														retainUntil: Dz.sql`GREATEST(${Db.productAnalyticsEventReceipts.retainUntil}, ${retainUntil})`,
													},
												});
											const [receipt] = await tx
												.select({
													payloadHash:
														Db.productAnalyticsEventReceipts.payloadHash,
												})
												.from(Db.productAnalyticsEventReceipts)
												.where(
													Dz.eq(
														Db.productAnalyticsEventReceipts.eventIdHash,
														eventIdHash,
													),
												)
												.limit(1)
												.for("update");
											if (receipt?.payloadHash === row.payload_hash) {
												admittedRows.push(row);
											} else {
												rejectedEventIds.push(row.event_id);
											}
										}
										return {
											acceptedEventIds: admittedRows.map((row) => row.event_id),
											rejectedEventIds,
											rows: admittedRows,
										};
									}),
								)
								.pipe(
									Effect.flatMap((admission) =>
										admission.rows.length === 0
											? Effect.succeed(admission)
											: service
													.append(admission.rows)
													.pipe(Effect.as(admission)),
									),
									Effect.ensuring(
										database
											.use((db) =>
												db
													.delete(Db.productAnalyticsIngestionLeases)
													.where(
														Dz.eq(
															Db.productAnalyticsIngestionLeases.id,
															leaseId,
														),
													),
											)
											.pipe(Effect.catchAll(() => Effect.void)),
									),
									Effect.map(({ acceptedEventIds, rejectedEventIds }) => ({
										acceptedEventIds,
										rejectedEventIds,
									})),
								),
						),
					);
			};

			return { ...service, appendWithIdentityFence } as const;
		}),
	},
) {}
