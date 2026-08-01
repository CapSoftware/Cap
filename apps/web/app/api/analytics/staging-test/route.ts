import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
	productAnalyticsEventIdHash,
	productAnalyticsIdentityHash,
} from "@cap/analytics";
import { db } from "@cap/database";
import {
	productAnalyticsErasureRequests,
	productAnalyticsEventReceipts,
	productAnalyticsIdentityLinks,
	productAnalyticsIdentityState,
	productAnalyticsOutbox,
} from "@cap/database/schema";
import { Tinybird } from "@cap/web-backend";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { inArray, or, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import type Stripe from "stripe";
import { queueServerProductEvent } from "@/lib/analytics/server";
import type { ServerProductEvent } from "@/lib/analytics/server-event";
import { subscriptionCheckoutProductEvent } from "@/lib/analytics/stripe-business-events";
import { apiToHandler } from "@/lib/server";

class Api extends HttpApi.make("AnalyticsStagingTestApi").add(
	HttpApiGroup.make("stagingTest")
		.add(
			HttpApiEndpoint.post("run", "/api/analytics/staging-test")
				.setPayload(
					Schema.Struct({
						scenario: Schema.Literal("business_lifecycle"),
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						accepted: Schema.Number,
						uniqueEvents: Schema.Number,
						workflowRuns: Schema.Array(Schema.String),
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		)
		.add(
			HttpApiEndpoint.post("erase", "/api/analytics/staging-test/erase")
				.setPayload(
					Schema.Struct({
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(Schema.Struct({ erased: Schema.Boolean }))
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		)
		.add(
			HttpApiEndpoint.post("health", "/api/analytics/staging-test/health")
				.setPayload(
					Schema.Struct({
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						activeEvents: Schema.Number,
						deadLetterEvents: Schema.Number,
						healthy: Schema.Boolean,
						oldestActiveAgeSeconds: Schema.Number,
						payloadConflictEvents: Schema.Number,
						provider429Retries: Schema.Number,
						provider503Retries: Schema.Number,
						providerRejectedDeadLetters: Schema.Number,
						receiptPayloadConflictAttempts: Schema.Number,
						receiptPayloadConflictEvents: Schema.Number,
						timeoutAfterAcceptRetries: Schema.Number,
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		)
		.add(
			HttpApiEndpoint.post(
				"cleanupDatabase",
				"/api/analytics/staging-test/cleanup-database",
			)
				.setPayload(
					Schema.Struct({
						anonymousIdentityHashes: Schema.Array(Schema.String),
						runId: Schema.String,
						scopeRunIds: Schema.Array(Schema.String),
						sha: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						cleaned: Schema.Boolean,
						identityHashes: Schema.Number,
						remaining: Schema.Number,
						runIds: Schema.Number,
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		)
		.add(
			HttpApiEndpoint.post("attest", "/api/analytics/staging-test/attest")
				.setPayload(
					Schema.Struct({
						runId: Schema.String,
						sha: Schema.String,
					}),
				)
				.addSuccess(
					Schema.Struct({
						databaseFingerprint: Schema.String,
						databaseSchema: Schema.Literal("0042_lying_sharon_ventura"),
						host: Schema.String,
						sha: Schema.String,
						workspaces: Schema.Array(
							Schema.Struct({
								name: Schema.String,
								tokenHash: Schema.String,
								workspaceId: Schema.String,
							}),
						),
					}),
				)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.Unauthorized)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.ServiceUnavailable),
		),
) {}

const RequestHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
	"x-cap-analytics-staging-signature": Schema.optional(Schema.String),
});

const safeEqual = (actual: string | undefined, expected: string) =>
	Boolean(
		actual &&
			actual.length === expected.length &&
			timingSafeEqual(Buffer.from(actual), Buffer.from(expected)),
	);

const boundedRunId = (value: string) =>
	/^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;

const draftSha = (value: string) => /^[0-9a-f]{40}$/.test(value);

const syntheticIdentities = (runId: string) => {
	const hash = createHash("sha256").update(runId).digest("hex");
	return {
		anonymousId: `synthetic_${hash.slice(0, 24)}`,
		hash,
		organizationId: `synthetic_org_${hash.slice(24, 48)}`,
		userId: `synthetic_user_${hash.slice(0, 24)}`,
	};
};

const syntheticEventIds = (runId: string) => {
	const { hash } = syntheticIdentities(runId);
	return [
		`staging_signup_${hash.slice(0, 24)}`,
		`staging_retry_429_${hash.slice(0, 24)}`,
		`staging_retry_503_${hash.slice(0, 24)}`,
		`staging_ambiguous_${hash.slice(0, 24)}`,
		`staging_reject_400_${hash.slice(0, 24)}`,
		`staging_erasure_replay_${hash.slice(0, 24)}`,
	];
};

const syntheticIdentityHashes = (runId: string) => {
	const { anonymousId, organizationId, userId } = syntheticIdentities(runId);
	return [
		productAnalyticsIdentityHash("anonymous", anonymousId),
		productAnalyticsIdentityHash("organization", organizationId),
		productAnalyticsIdentityHash("user", userId),
	];
};

const scopedDatabaseHealth = async (runId: string) => {
	const eventIds = syntheticEventIds(runId);
	const eventIdHashes = eventIds.map(productAnalyticsEventIdHash);
	const [outboxRows, receiptRows] = await Promise.all([
		db()
			.select({
				createdAt: productAnalyticsOutbox.createdAt,
				lastErrorCode: productAnalyticsOutbox.lastErrorCode,
				payloadConflict: productAnalyticsOutbox.payloadConflict,
				status: productAnalyticsOutbox.status,
			})
			.from(productAnalyticsOutbox)
			.where(inArray(productAnalyticsOutbox.eventId, eventIds)),
		db()
			.select({ conflictCount: productAnalyticsEventReceipts.conflictCount })
			.from(productAnalyticsEventReceipts)
			.where(inArray(productAnalyticsEventReceipts.eventIdHash, eventIdHashes)),
	]);
	const activeRows = outboxRows.filter((row) =>
		["pending", "workflow_started"].includes(row.status),
	);
	const oldestActiveAt = activeRows.reduce(
		(oldest, row) => Math.min(oldest, row.createdAt.getTime()),
		Date.now(),
	);
	const countError = (code: string) =>
		outboxRows.filter((row) => row.lastErrorCode === code).length;
	const receiptPayloadConflictEvents = receiptRows.filter(
		(row) => row.conflictCount > 0,
	).length;
	const receiptPayloadConflictAttempts = receiptRows.reduce(
		(sum, row) => sum + row.conflictCount,
		0,
	);
	const deadLetterEvents = outboxRows.filter(
		(row) => row.status === "dead_letter",
	).length;
	const payloadConflictEvents = outboxRows.filter(
		(row) => row.payloadConflict,
	).length;
	return {
		activeEvents: activeRows.length,
		deadLetterEvents,
		healthy:
			activeRows.length === 0 &&
			deadLetterEvents === 0 &&
			payloadConflictEvents === 0 &&
			receiptPayloadConflictEvents === 0,
		oldestActiveAgeSeconds:
			activeRows.length === 0
				? 0
				: Math.max(0, Math.floor((Date.now() - oldestActiveAt) / 1_000)),
		payloadConflictEvents,
		provider429Retries: countError("staging_provider_429"),
		provider503Retries: countError("staging_provider_503"),
		providerRejectedDeadLetters: outboxRows.filter(
			(row) =>
				row.status === "dead_letter" &&
				row.lastErrorCode === "provider_rejected",
		).length,
		receiptPayloadConflictAttempts,
		receiptPayloadConflictEvents,
		timeoutAfterAcceptRetries: countError("staging_timeout_after_accept"),
	};
};

const cleanupSyntheticDatabaseState = async ({
	anonymousIdentityHashes,
	runIds,
}: {
	anonymousIdentityHashes: readonly string[];
	runIds: readonly string[];
}) => {
	const identities = runIds.map(syntheticIdentities);
	const eventIds = runIds.flatMap(syntheticEventIds);
	const eventIdHashes = eventIds.map(productAnalyticsEventIdHash);
	const identityHashes = [
		...new Set([
			...anonymousIdentityHashes,
			...runIds.flatMap(syntheticIdentityHashes),
		]),
	];
	const anonymousIds = identities.map(({ anonymousId }) => anonymousId);
	const organizationIds = identities.map(
		({ organizationId }) => organizationId,
	);
	const userIds = identities.map(({ userId }) => userId);
	await db().transaction(async (tx) => {
		await tx
			.delete(productAnalyticsIdentityLinks)
			.where(
				or(
					inArray(
						productAnalyticsIdentityLinks.anonymousIdentityHash,
						identityHashes,
					),
					inArray(
						productAnalyticsIdentityLinks.userIdentityHash,
						identityHashes,
					),
					inArray(
						productAnalyticsIdentityLinks.organizationIdentityHash,
						identityHashes,
					),
				),
			);
		await tx
			.delete(productAnalyticsEventReceipts)
			.where(
				or(
					inArray(productAnalyticsEventReceipts.eventIdHash, eventIdHashes),
					inArray(
						productAnalyticsEventReceipts.anonymousIdentityHash,
						identityHashes,
					),
					inArray(
						productAnalyticsEventReceipts.userIdentityHash,
						identityHashes,
					),
					inArray(
						productAnalyticsEventReceipts.organizationIdentityHash,
						identityHashes,
					),
				),
			);
		await tx
			.delete(productAnalyticsOutbox)
			.where(
				or(
					inArray(productAnalyticsOutbox.eventId, eventIds),
					inArray(productAnalyticsOutbox.anonymousId, anonymousIds),
					inArray(productAnalyticsOutbox.userId, userIds),
					inArray(productAnalyticsOutbox.organizationId, organizationIds),
				),
			);
		await tx
			.delete(productAnalyticsErasureRequests)
			.where(
				or(
					inArray(productAnalyticsErasureRequests.userId, userIds),
					inArray(
						productAnalyticsErasureRequests.organizationId,
						organizationIds,
					),
				),
			);
		await tx
			.delete(productAnalyticsIdentityState)
			.where(
				inArray(productAnalyticsIdentityState.identityHash, identityHashes),
			);
	});
	const [remainingOutbox, remainingReceipts, remainingLinks, remainingStates] =
		await Promise.all([
			db()
				.select({ eventId: productAnalyticsOutbox.eventId })
				.from(productAnalyticsOutbox)
				.where(inArray(productAnalyticsOutbox.eventId, eventIds)),
			db()
				.select({ eventIdHash: productAnalyticsEventReceipts.eventIdHash })
				.from(productAnalyticsEventReceipts)
				.where(
					inArray(productAnalyticsEventReceipts.eventIdHash, eventIdHashes),
				),
			db()
				.select({
					anonymousIdentityHash:
						productAnalyticsIdentityLinks.anonymousIdentityHash,
				})
				.from(productAnalyticsIdentityLinks)
				.where(
					or(
						inArray(
							productAnalyticsIdentityLinks.anonymousIdentityHash,
							identityHashes,
						),
						inArray(
							productAnalyticsIdentityLinks.userIdentityHash,
							identityHashes,
						),
					),
				),
			db()
				.select({ identityHash: productAnalyticsIdentityState.identityHash })
				.from(productAnalyticsIdentityState)
				.where(
					inArray(productAnalyticsIdentityState.identityHash, identityHashes),
				),
		]);
	return {
		identityHashes: identityHashes.length,
		remaining:
			remainingOutbox.length +
			remainingReceipts.length +
			remainingLinks.length +
			remainingStates.length,
		runIds: runIds.length,
	};
};

const tinybirdTokenNames = [
	"PRODUCT_ANALYTICS_TINYBIRD_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN",
	"PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN",
] as const;
const TINYBIRD_STAGING_ORIGIN = "https://api.us-east.aws.tinybird.co";
const TINYBIRD_STAGING_WORKSPACE_ID = "37b8fef9-817f-4c3c-b21f-218c36a6077d";
const STAGING_DATABASE_FINGERPRINT =
	"fff37a9b160f31bfb82b8c5585829b8ee08f70b3645169dca6e7cb29033a039a";

const tokenWorkspaceId = (token: string) => {
	const segment = token.split(".")[1];
	if (!segment) return undefined;
	try {
		const payload: unknown = JSON.parse(
			Buffer.from(segment, "base64url").toString("utf8"),
		);
		if (!payload || typeof payload !== "object") return undefined;
		const record = payload as Record<string, unknown>;
		const workspaceId = record.u ?? record.workspace_id ?? record.workspaceId;
		return typeof workspaceId === "string" ? workspaceId : undefined;
	} catch {
		return undefined;
	}
};

const configurationAttestation = (runId: string) => {
	const host = process.env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const sha = process.env.VERCEL_GIT_COMMIT_SHA;
	const secret = process.env.CAP_ANALYTICS_STAGING_TEST_SECRET;
	const databaseUrl = process.env.DATABASE_URL;
	if (!host || !sha || !secret || !databaseUrl) return undefined;
	const databaseFingerprint = createHash("sha256")
		.update(databaseUrl)
		.digest("hex");
	if (databaseFingerprint !== STAGING_DATABASE_FINGERPRINT) return undefined;
	let origin: string;
	try {
		origin = new URL(host).origin;
	} catch {
		return undefined;
	}
	const workspaces = tinybirdTokenNames.map((name) => {
		const token = process.env[name];
		if (!token) return undefined;
		const workspaceId = tokenWorkspaceId(token);
		if (!workspaceId) return undefined;
		return {
			name,
			tokenHash: createHmac("sha256", `${secret}:${runId}`)
				.update(token)
				.digest("hex"),
			workspaceId,
		};
	});
	if (workspaces.some((workspace) => !workspace)) return undefined;
	if (
		origin !== TINYBIRD_STAGING_ORIGIN ||
		workspaces.some(
			(workspace) => workspace?.workspaceId !== TINYBIRD_STAGING_WORKSPACE_ID,
		)
	) {
		return undefined;
	}
	return {
		databaseFingerprint,
		host: origin,
		sha,
		workspaces: workspaces.filter(
			(workspace): workspace is NonNullable<typeof workspace> =>
				Boolean(workspace),
		),
	};
};

const databaseResultRows = (result: unknown) => {
	if (!Array.isArray(result)) return [];
	const rows = Array.isArray(result[0]) ? result[0] : result;
	return rows.filter(
		(row): row is Record<string, unknown> =>
			typeof row === "object" && row !== null && !Array.isArray(row),
	);
};

const attestDatabaseSchema = async () => {
	const tableNames = [
		"comments",
		"organization_invites",
		"product_analytics_erasure_requests",
		"product_analytics_event_receipts",
		"product_analytics_identity_links",
		"product_analytics_ingestion_leases",
		"product_analytics_outbox",
		"product_analytics_refresh_leases",
		"product_analytics_reconciliation_failures",
		"users",
		"videos",
	];
	const tableNamesSql = sql.join(
		tableNames.map((tableName) => sql`${tableName}`),
		sql`, `,
	);
	const [columnResult, indexResult] = await Promise.all([
		db().execute(sql`
			SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
				COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
				COLUMN_DEFAULT AS columnDefault, COLUMN_KEY AS columnKey
			FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE()
				AND TABLE_NAME IN (${tableNamesSql})
		`),
		db().execute(sql`
			SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
				NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
				COLUMN_NAME AS columnName
			FROM information_schema.STATISTICS
			WHERE TABLE_SCHEMA = DATABASE()
				AND TABLE_NAME IN (${tableNamesSql})
		`),
	]);
	const columnSignatures = new Set(
		databaseResultRows(columnResult).map((row) =>
			[
				row.tableName,
				row.columnName,
				row.columnType,
				row.isNullable,
				row.columnDefault ?? "NULL",
				row.columnKey ?? "",
			]
				.map(String)
				.join(":"),
		),
	);
	const indexSignatures = new Set(
		databaseResultRows(indexResult).map((row) =>
			[
				row.tableName,
				row.indexName,
				Number(row.nonUnique),
				Number(row.sequence),
				row.columnName,
			].join(":"),
		),
	);
	const requiredColumns = [
		"organization_invites:emailDeliveryState:varchar(32):NO:legacy:MUL",
		"product_analytics_event_receipts:eventIdHash:varchar(64):NO:NULL:PRI",
		"product_analytics_ingestion_leases:fencingToken:bigint unsigned:NO:NULL:",
		"product_analytics_outbox:eventId:varchar(128):NO:NULL:PRI",
		"product_analytics_refresh_leases:name:varchar(64):NO:NULL:PRI",
		"product_analytics_reconciliation_failures:attemptCount:int:NO:1:",
		"product_analytics_reconciliation_failures:sourceHash:varchar(64):NO:NULL:PRI",
	];
	const requiredIndexes = [
		"comments:analytics_reconciliation_idx:1:1:createdAt",
		"comments:analytics_reconciliation_idx:1:2:id",
		"organization_invites:email_delivery_idx:1:1:emailDeliveryState",
		"organization_invites:email_delivery_idx:1:2:emailDeliveryNextAttemptAt",
		"organization_invites:normalized_email_idx:0:1:organizationId",
		"organization_invites:normalized_email_idx:0:2:invitedEmailNormalized",
		"product_analytics_erasure_requests:scope_hash_idx:0:1:scopeHash",
		"product_analytics_event_receipts:PRIMARY:0:1:eventIdHash",
		"product_analytics_event_receipts:conflict_idx:1:1:conflictCount",
		"product_analytics_identity_links:PRIMARY:0:1:anonymousIdentityHash",
		"product_analytics_identity_links:PRIMARY:0:2:userIdentityHash",
		"product_analytics_ingestion_leases:PRIMARY:0:1:id",
		"product_analytics_ingestion_leases:expiry_idx:1:1:expiresAt",
		"product_analytics_outbox:PRIMARY:0:1:eventId",
		"product_analytics_outbox:delivery_key_idx:0:1:deliveryKey",
		"product_analytics_outbox:delivery_idx:1:1:status",
		"product_analytics_outbox:delivery_idx:1:2:nextAttemptAt",
		"product_analytics_outbox:delivery_idx:1:3:createdAt",
		"product_analytics_refresh_leases:PRIMARY:0:1:name",
		"product_analytics_refresh_leases:expiry_idx:1:1:leaseExpiresAt",
		"product_analytics_refresh_leases:status_idx:1:1:status",
		"product_analytics_reconciliation_failures:PRIMARY:0:1:sourceHash",
		"product_analytics_reconciliation_failures:source_type_idx:1:1:sourceType",
		"product_analytics_reconciliation_failures:source_type_idx:1:2:lastSeenAt",
		"users:analytics_reconciliation_idx:1:1:created_at",
		"users:analytics_reconciliation_idx:1:2:id",
		"videos:analytics_created_at_idx:1:1:createdAt",
		"videos:analytics_created_at_idx:1:2:id",
		"videos:analytics_first_view_at_idx:1:1:firstExternalViewAt",
		"videos:analytics_first_view_at_idx:1:2:id",
	];
	if (
		requiredColumns.some((signature) => !columnSignatures.has(signature)) ||
		requiredIndexes.some((signature) => !indexSignatures.has(signature))
	) {
		throw new Error("The staging database schema signature is incomplete");
	}
};

const authorize = (payload: { runId: string; sha: string }) =>
	Effect.gen(function* () {
		const secret = process.env.CAP_ANALYTICS_STAGING_TEST_SECRET;
		if (!secret) {
			return yield* Effect.fail(new HttpApiError.ServiceUnavailable());
		}
		const headers = yield* HttpServerRequest.schemaHeaders(RequestHeaders).pipe(
			Effect.mapError(() => new HttpApiError.BadRequest()),
		);
		if (!safeEqual(headers.authorization, `Bearer ${secret}`)) {
			return yield* Effect.fail(new HttpApiError.Unauthorized());
		}
		const runId = boundedRunId(payload.runId);
		if (!runId || !draftSha(payload.sha)) {
			return yield* Effect.fail(new HttpApiError.BadRequest());
		}
		const expectedSignature = createHmac("sha256", secret)
			.update(`${runId}:${payload.sha}`)
			.digest("hex");
		if (
			!safeEqual(
				headers["x-cap-analytics-staging-signature"],
				expectedSignature,
			)
		) {
			return yield* Effect.fail(new HttpApiError.Unauthorized());
		}
		if (
			payload.sha !== process.env.VERCEL_GIT_COMMIT_SHA ||
			!configurationAttestation(runId)
		) {
			return yield* Effect.fail(new HttpApiError.BadRequest());
		}
		return runId;
	});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "stagingTest", (handlers) =>
			Effect.gen(function* () {
				const tinybird = yield* Tinybird;
				return handlers
					.handle("attest", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const attestation = configurationAttestation(runId);
							if (!attestation) {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							yield* Effect.tryPromise({
								try: attestDatabaseSchema,
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							return {
								...attestation,
								databaseSchema: "0042_lying_sharon_ventura" as const,
							};
						}),
					)
					.handle("run", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const { anonymousId, hash, organizationId, userId } =
								syntheticIdentities(runId);
							const occurredAt = new Date().toISOString();
							const purchase = subscriptionCheckoutProductEvent({
								eventId: `staging_ambiguous_${hash.slice(0, 24)}`,
								occurredAt,
								session: {
									amount_subtotal: 2_500,
									amount_total: 2_500,
									currency: "usd",
									metadata: {
										analyticsAnonymousId: anonymousId,
										analyticsIsFirstPurchase: "true",
										analyticsOrganizationId: organizationId,
										analyticsPriceId: "price_staging_annual",
										analyticsQuantity: "1",
										analyticsSchemaVersion: "1",
										isOnBoarding: "false",
										platform: "web",
									},
									payment_status: "paid",
									total_details: { amount_discount: 0 },
								} as unknown as Stripe.Checkout.Session,
								user: { id: userId },
							});
							if (!purchase) {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							const events: ServerProductEvent[] = [
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_signup_${hash.slice(0, 24)}`,
									eventName: "user_signed_up",
									occurredAt,
									organizationId,
									platform: "web",
									userId,
								},
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_retry_429_${hash.slice(0, 24)}`,
									eventName: "share_link_created",
									occurredAt,
									organizationId,
									platform: "server",
									properties: {
										asset_type: "recording",
										recording_mode: "screen",
									},
									userId,
								},
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_retry_503_${hash.slice(0, 24)}`,
									eventName: "checkout_started",
									occurredAt,
									organizationId,
									platform: "web",
									properties: {
										is_onboarding: false,
										price_id: "price_staging_annual",
										quantity: 1,
									},
									userId,
								},
								{ ...purchase, _syntheticRunId: runId },
								{
									_syntheticRunId: runId,
									anonymousId,
									eventId: `staging_reject_400_${hash.slice(0, 24)}`,
									eventName: "organization_member_joined",
									occurredAt,
									organizationId,
									platform: "web",
									properties: {
										assigned_pro_seat: false,
										role: "member",
									},
									userId,
								},
							];
							const deliveries = yield* Effect.tryPromise({
								try: () => Promise.all(events.map(queueServerProductEvent)),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							if (
								deliveries.some((delivery) => delivery.status !== "started")
							) {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							return {
								accepted: events.length,
								uniqueEvents: new Set(events.map((event) => event.eventId))
									.size,
								workflowRuns: deliveries.map(({ runId }) => runId),
							};
						}),
					)
					.handle("health", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const health = yield* Effect.tryPromise({
								try: () => scopedDatabaseHealth(runId),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							return health;
						}),
					)
					.handle("cleanupDatabase", ({ payload }) =>
						Effect.gen(function* () {
							yield* authorize(payload);
							const runIds = [
								...new Set(payload.scopeRunIds.map(boundedRunId)),
							].filter((runId) => runId !== undefined);
							const anonymousIdentityHashes = [
								...new Set(payload.anonymousIdentityHashes),
							].filter((identityHash) => /^[0-9a-f]{64}$/.test(identityHash));
							if (
								runIds.length === 0 ||
								runIds.length !== payload.scopeRunIds.length ||
								runIds.length > 8 ||
								anonymousIdentityHashes.length !==
									payload.anonymousIdentityHashes.length ||
								anonymousIdentityHashes.length > 16
							) {
								return yield* Effect.fail(new HttpApiError.BadRequest());
							}
							const cleanup = yield* Effect.tryPromise({
								try: () =>
									cleanupSyntheticDatabaseState({
										anonymousIdentityHashes,
										runIds,
									}),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							if (cleanup.remaining !== 0) {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							return { ...cleanup, cleaned: true };
						}),
					)
					.handle("erase", ({ payload }) =>
						Effect.gen(function* () {
							const runId = yield* authorize(payload);
							const { anonymousId, hash, organizationId, userId } =
								syntheticIdentities(runId);
							yield* tinybird
								.eraseProductAnalytics({
									userId,
									organizationId,
								})
								.pipe(
									Effect.mapError(() => new HttpApiError.ServiceUnavailable()),
								);
							const replay = yield* Effect.tryPromise({
								try: () =>
									queueServerProductEvent({
										_syntheticRunId: runId,
										anonymousId,
										eventId: `staging_erasure_replay_${hash.slice(0, 24)}`,
										eventName: "user_signed_up",
										occurredAt: new Date().toISOString(),
										organizationId,
										platform: "web",
										userId,
									}),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							if (replay.status !== "suppressed") {
								return yield* Effect.fail(
									new HttpApiError.ServiceUnavailable(),
								);
							}
							return { erased: true };
						}),
					);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);
export const POST = handler;
