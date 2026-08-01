import type { RowDataPacket } from "mysql2";
import mysql, { type Connection } from "mysql2/promise";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow/api", () => ({
	start: vi.fn(async () => ({ runId: "analytics-mysql-e2e" })),
}));

const inviteMocks = vi.hoisted(() => ({
	environment: {
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://staging.tinybird.test",
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN: "staging-ingest-token",
		RESEND_API_KEY: "staging-resend-key",
		WEB_URL: "https://staging.cap.test",
	},
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: inviteMocks.sendEmail,
}));
vi.mock("@cap/database/emails/organization-invite", () => ({
	OrganizationInvite: vi.fn(() => null),
}));
vi.mock("@cap/env", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/env")>()),
	serverEnv: () => inviteMocks.environment,
}));

const enabled = process.env.CAP_PRODUCT_ANALYTICS_MYSQL_E2E === "1";
const analyticsMysqlE2e = enabled ? describe.sequential : describe.skip;
const databaseName =
	process.env.CAP_PRODUCT_ANALYTICS_MYSQL_DATABASE ??
	`cap_product_analytics_e2e_${process.pid}`;
const adminUrl =
	process.env.CAP_PRODUCT_ANALYTICS_MYSQL_ADMIN_URL ??
	"mysql://root@127.0.0.1:3306";
const databaseUrl = `${adminUrl}/${databaseName}`;

let admin: Connection;

afterEach(() => {
	vi.unstubAllGlobals();
});

const runRepo = async <T>(
	operation: (
		repo: import("@cap/web-backend").ProductAnalyticsErasureLeaseStore,
	) => import("effect").Effect.Effect<T, Error>,
) => {
	const { Database, ProductAnalyticsErasureLeaseRepo } = await import(
		"@cap/web-backend"
	);
	const { Effect } = await import("effect");
	return Effect.runPromise(
		Effect.gen(function* () {
			const repo = yield* ProductAnalyticsErasureLeaseRepo;
			return yield* operation(repo);
		}).pipe(
			Effect.provide(ProductAnalyticsErasureLeaseRepo.Default),
			Effect.provide(Database.Default),
		),
	);
};

const appendCollectorRows = async (
	rows: readonly import("@cap/analytics").ProductEventRow[],
) => {
	const { Database, ProductAnalytics } = await import("@cap/web-backend");
	const { Effect } = await import("effect");
	return Effect.runPromise(
		Effect.gen(function* () {
			const analytics = yield* ProductAnalytics;
			return yield* analytics.appendWithIdentityFence(rows);
		}).pipe(
			Effect.provide(ProductAnalytics.Default),
			Effect.provide(Database.Default),
		),
	);
};

const appendCollectorRowsEither = async (
	rows: readonly import("@cap/analytics").ProductEventRow[],
) => {
	const { Database, ProductAnalytics } = await import("@cap/web-backend");
	const { Effect } = await import("effect");
	return Effect.runPromise(
		Effect.gen(function* () {
			const analytics = yield* ProductAnalytics;
			return yield* analytics.appendWithIdentityFence(rows);
		}).pipe(
			Effect.either,
			Effect.provide(ProductAnalytics.Default),
			Effect.provide(Database.Default),
		),
	);
};

beforeAll(async () => {
	if (!enabled) return;
	const parsed = new URL(adminUrl);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "3306" ||
		!/^[a-z0-9_]+$/.test(databaseName) ||
		!databaseName.startsWith("cap_product_analytics_e2e_")
	) {
		throw new Error("Analytics MySQL E2E requires an isolated local database");
	}
	admin = await mysql.createConnection(adminUrl);
	await admin.query(`CREATE DATABASE \`${databaseName}\``);
	process.env.DATABASE_URL = databaseUrl;
	const connection = await mysql.createConnection(databaseUrl);
	await connection.query(`
		CREATE TABLE product_analytics_erasure_leases (
			name varchar(64) NOT NULL PRIMARY KEY,
			ownerId varchar(64), requestId varchar(64),
			fencingToken bigint unsigned NOT NULL DEFAULT 0,
			leaseExpiresAt timestamp NULL, phase varchar(32) NOT NULL DEFAULT 'idle',
			pausedPipes json, userId varchar(255), organizationId varchar(255),
			attemptCount int NOT NULL DEFAULT 0, lastErrorCode varchar(64),
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_identity_state (
			identityHash varchar(64) NOT NULL PRIMARY KEY,
			identityKind varchar(16) NOT NULL, blockedAt timestamp NULL,
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_identity_links (
			anonymousIdentityHash varchar(64) NOT NULL,
			userIdentityHash varchar(64) NOT NULL,
			organizationIdentityHash varchar(64), anonymousId varchar(255) NOT NULL,
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			PRIMARY KEY (anonymousIdentityHash, userIdentityHash)
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_event_receipts (
			eventIdHash varchar(64) NOT NULL PRIMARY KEY, payloadHash varchar(32) NOT NULL,
			anonymousIdentityHash varchar(64), userIdentityHash varchar(64),
			organizationIdentityHash varchar(64), conflictCount int NOT NULL DEFAULT 0,
			firstSeenAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			lastSeenAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			retainUntil timestamp NOT NULL
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_outbox (
			eventId varchar(128) NOT NULL PRIMARY KEY, deliveryKey varchar(36) NOT NULL UNIQUE,
			payloadHash varchar(32) NOT NULL, eventName varchar(64) NOT NULL,
			payloadKind varchar(32) NOT NULL DEFAULT 'product_event_row_v1', payload json NOT NULL,
			anonymousId varchar(255), userId varchar(255), organizationId varchar(255),
			status varchar(32) NOT NULL DEFAULT 'pending', attemptCount int NOT NULL DEFAULT 0,
			nextAttemptAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, leaseOwnerId varchar(64),
			leaseExpiresAt timestamp NULL, workflowRunId varchar(128),
			payloadConflict boolean NOT NULL DEFAULT false, lastErrorCode varchar(64),
			deliveredAt timestamp NULL, deadLetteredAt timestamp NULL,
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_ingestion_leases (
			id varchar(36) NOT NULL PRIMARY KEY, fencingToken bigint unsigned NOT NULL,
			expiresAt timestamp NOT NULL,
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_refresh_leases (
			name varchar(64) NOT NULL PRIMARY KEY, ownerId varchar(36),
			generation bigint unsigned NOT NULL DEFAULT 0, sourceCutoff timestamp NULL,
			leaseExpiresAt timestamp NULL, status varchar(32) NOT NULL DEFAULT 'idle',
			lastCompletedAt timestamp NULL, lastErrorCode varchar(64),
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			KEY expiry_idx (leaseExpiresAt), KEY status_idx (status)
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_reconciliation_failures (
			sourceHash varchar(64) NOT NULL PRIMARY KEY, sourceType varchar(32) NOT NULL,
			errorCode varchar(64) NOT NULL, attemptCount int NOT NULL DEFAULT 1,
			firstSeenAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			lastSeenAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			KEY source_type_idx (sourceType, lastSeenAt)
		)
	`);
	await connection.query(`
		CREATE TABLE product_analytics_erasure_requests (
			id varchar(36) NOT NULL PRIMARY KEY, scopeHash varchar(64) NOT NULL UNIQUE,
			userId varchar(255), organizationId varchar(255),
			status varchar(32) NOT NULL DEFAULT 'pending', attemptCount int NOT NULL DEFAULT 0,
			nextAttemptAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, leaseOwnerId varchar(36),
			leaseExpiresAt timestamp NULL, lastErrorCode varchar(64),
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		)
	`);
	await connection.query(`
		CREATE TABLE organizations (
			id varchar(21) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL,
			tombstoneAt timestamp NULL
		)
	`);
	await connection.query(`
		CREATE TABLE organization_invites (
			id varchar(21) NOT NULL PRIMARY KEY, organizationId varchar(21) NOT NULL,
			invitedEmail varchar(255) NOT NULL, invitedEmailNormalized varchar(255),
			invitedByUserId varchar(21) NOT NULL, role varchar(255) NOT NULL,
			status varchar(255) NOT NULL DEFAULT 'pending',
			emailDeliveryState varchar(32) NOT NULL DEFAULT 'legacy',
			emailDeliveryAttemptCount int NOT NULL DEFAULT 0,
			emailDeliveryNextAttemptAt timestamp NULL, emailDeliveryErrorCode varchar(64),
			emailDeliveryLeaseOwnerId varchar(36), emailDeliveryLeaseExpiresAt timestamp NULL,
			emailProviderMessageId varchar(255), emailSentAt timestamp NULL,
			createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updatedAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			expiresAt timestamp NULL,
			UNIQUE KEY normalized_email_idx (organizationId, invitedEmailNormalized)
		)
	`);
	await connection.end();
});

afterAll(async () => {
	if (!enabled || !admin) return;
	if (!databaseName.startsWith("cap_product_analytics_e2e_")) {
		throw new Error("Refusing to drop an unscoped database");
	}
	await admin.query(`DROP DATABASE \`${databaseName}\``);
	await admin.end();
});

analyticsMysqlE2e("product analytics MySQL concurrency", () => {
	it("reuses the global lease and increments its fencing token", async () => {
		const first = await runRepo((repo) => repo.claimNew({ userId: "user-a" }));
		expect(first).not.toBeNull();
		if (!first) return;
		expect(await runRepo((repo) => repo.complete(first))).toBe(true);
		const second = await runRepo((repo) => repo.claimNew({ userId: "user-b" }));
		expect(second?.requestId).not.toBe(first.requestId);
		expect(second?.fencingToken).toBe(first.fencingToken + 1);
		if (second)
			expect(await runRepo((repo) => repo.complete(second))).toBe(true);
	});

	it("allows exactly one concurrent owner", async () => {
		const claims = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				runRepo((repo) => repo.claimNew({ userId: `concurrent-${index}` })),
			),
		);
		const winners = claims.filter((claim) => claim !== null);
		expect(winners).toHaveLength(1);
		const winner = winners[0];
		if (winner) {
			expect(await runRepo((repo) => repo.complete(winner))).toBe(true);
		}
	});

	it("admits concurrent ingestion without owning the erasure row lock", async () => {
		const {
			acquireProductAnalyticsIngestionLease,
			releaseProductAnalyticsIngestionLease,
		} = await import("@/lib/analytics/product-event-outbox-state");
		const leases = await Promise.all(
			Array.from({ length: 32 }, () => acquireProductAnalyticsIngestionLease()),
		);
		expect(leases.every((lease) => typeof lease === "string")).toBe(true);
		expect(new Set(leases).size).toBe(32);
		await Promise.all(
			leases.flatMap((lease) =>
				lease ? [releaseProductAnalyticsIngestionLease(lease)] : [],
			),
		);
	});

	it("allows one refresh owner and fences refresh against erasure", async () => {
		const {
			acquireProductAnalyticsRefreshLease,
			releaseProductAnalyticsRefreshLease,
		} = await import("@/lib/analytics/product-analytics-refresh-state");
		const cutoff = new Date("2026-07-31T12:00:00.000Z");
		const claims = await Promise.all(
			Array.from({ length: 8 }, () =>
				acquireProductAnalyticsRefreshLease(cutoff),
			),
		);
		const winners = claims.filter((claim): claim is NonNullable<typeof claim> =>
			Boolean(claim),
		);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.sourceCutoff).toBe(cutoff.toISOString());
		if (!winners[0]) return;
		await releaseProductAnalyticsRefreshLease(winners[0].ownerId);

		const verifier = await mysql.createConnection(databaseUrl);
		await verifier.query(
			"UPDATE product_analytics_erasure_leases SET phase = 'claimed' WHERE name = 'global'",
		);
		await expect(
			acquireProductAnalyticsRefreshLease(cutoff),
		).resolves.toBeUndefined();
		await verifier.query(
			"UPDATE product_analytics_erasure_leases SET phase = 'idle' WHERE name = 'global'",
		);
		const [refreshRows] = await verifier.query<
			Array<
				{
					generation: number;
					ownerId: string | null;
					status: string;
				} & RowDataPacket
			>
		>(
			"SELECT ownerId, generation, status FROM product_analytics_refresh_leases WHERE name = 'global'",
		);
		const [ingestionRows] = await verifier.query<Array<RowDataPacket>>(
			"SELECT id FROM product_analytics_ingestion_leases",
		);
		await verifier.end();
		expect(refreshRows[0]).toMatchObject({
			generation: 1,
			ownerId: null,
			status: "idle",
		});
		expect(ingestionRows).toHaveLength(0);
	});

	it("isolates payload conflicts without poisoning valid batch neighbors", async () => {
		const { createProductEventRows, productAnalyticsEventIdHash } =
			await import("@cap/analytics");
		const appendRequests: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				appendRequests.push(String(init?.body ?? ""));
				return new Response(null, { status: 202 });
			}),
		);
		const [original] = createProductEventRows(
			[
				{
					anonymousId: "collector-anonymous",
					eventId: "collector-retry-alpha",
					eventName: "page_view",
					occurredAt: "2026-07-31T12:00:00.000Z",
					platform: "web",
					properties: {
						hostname: "cap.test",
						is_session_entry: true,
						session_started_at: "2026-07-31T12:00:00.000Z",
					},
				},
			],
			{
				hostname: "cap.test",
				receivedAt: "2026-07-31T12:00:01.000Z",
				source: "client",
			},
		);
		if (!original) throw new Error("Expected a collector fixture row");
		await Promise.all([
			appendCollectorRows([original]),
			appendCollectorRows([original]),
		]);
		expect(appendRequests).toHaveLength(2);

		const conflicting = {
			...original,
			pathname: "/different",
			payload_hash: "f".repeat(32),
		};
		const validNeighbor = {
			...original,
			event_id: `${original.event_id}_neighbor`,
			payload_hash: "e".repeat(32),
		};
		const admission = await appendCollectorRowsEither([
			conflicting,
			validNeighbor,
		]);
		expect(admission).toMatchObject({
			_tag: "Right",
			right: {
				acceptedEventIds: [validNeighbor.event_id],
				rejectedEventIds: [original.event_id],
			},
		});
		expect(appendRequests).toHaveLength(3);
		expect(appendRequests[2]).toContain(validNeighbor.event_id);
		expect(appendRequests[2]).not.toContain(conflicting.payload_hash);
		const verifier = await mysql.createConnection(databaseUrl);
		const [receipts] = await verifier.query<
			Array<
				{
					conflictCount: number;
					payloadHash: string;
				} & RowDataPacket
			>
		>(
			"SELECT payloadHash, conflictCount FROM product_analytics_event_receipts WHERE eventIdHash = ?",
			[productAnalyticsEventIdHash(original.event_id)],
		);
		expect(receipts[0]).toMatchObject({
			conflictCount: 1,
			payloadHash: original.payload_hash,
		});
		await verifier.query(
			"DELETE FROM product_analytics_event_receipts WHERE eventIdHash IN (?, ?)",
			[
				productAnalyticsEventIdHash(original.event_id),
				productAnalyticsEventIdHash(validNeighbor.event_id),
			],
		);
		await verifier.end();
	});

	it("keeps untrusted client IDs disjoint from authoritative server IDs", async () => {
		const { createProductEventRows, productAnalyticsEventIdHash } =
			await import("@cap/analytics");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 202 })),
		);
		const rawEventId = "share_link_created:known-video-id";
		const [clientRow] = createProductEventRows(
			[
				{
					anonymousId: "preclaim-anonymous",
					eventId: rawEventId,
					eventName: "page_view",
					occurredAt: "2026-07-31T12:00:00.000Z",
					platform: "web",
					properties: {
						hostname: "cap.test",
						is_session_entry: true,
						session_started_at: "2026-07-31T12:00:00.000Z",
					},
				},
			],
			{
				hostname: "cap.test",
				receivedAt: "2026-07-31T12:00:01.000Z",
				source: "client",
			},
		);
		const [serverRow] = createProductEventRows(
			[
				{
					anonymousId: "user:preclaim-user",
					eventId: rawEventId,
					eventName: "share_link_created",
					occurredAt: "2026-07-31T12:00:02.000Z",
					platform: "server",
					properties: {
						asset_type: "recording",
						recording_mode: "instant",
					},
				},
			],
			{
				organizationId: "preclaim-org",
				receivedAt: "2026-07-31T12:00:03.000Z",
				source: "server",
				userId: "preclaim-user",
			},
		);
		if (!clientRow || !serverRow) throw new Error("Expected preclaim fixtures");
		expect(clientRow.event_id).not.toBe(serverRow.event_id);
		const clientAdmission = await appendCollectorRows([clientRow]);
		const serverAdmission = await appendCollectorRows([serverRow]);
		expect(clientAdmission.acceptedEventIds).toEqual([clientRow.event_id]);
		expect(serverAdmission.acceptedEventIds).toEqual([serverRow.event_id]);

		const verifier = await mysql.createConnection(databaseUrl);
		await verifier.query(
			"DELETE FROM product_analytics_event_receipts WHERE eventIdHash IN (?, ?)",
			[
				productAnalyticsEventIdHash(clientRow.event_id),
				productAnalyticsEventIdHash(serverRow.event_id),
			],
		);
		await verifier.end();
	});

	it("preserves another user's event when an anonymous cookie is shared", async () => {
		const { db } = await import("@cap/database");
		const { persistProductAnalyticsEvent } = await import(
			"@/lib/analytics/product-event-outbox"
		);
		const anonymousId = "shared-cookie-alpha";
		for (const userId of ["shared-user-a", "shared-user-b"]) {
			await db().transaction((tx) =>
				persistProductAnalyticsEvent(tx, {
					eventId: `${userId}:signup`,
					eventName: "user_signed_up",
					occurredAt: new Date().toISOString(),
					anonymousId,
					platform: "web",
					userId,
					organizationId: `${userId}:org`,
				}),
			);
		}
		const aliases = await runRepo((repo) =>
			repo.discardPendingEvents({ userId: "shared-user-a" }, [anonymousId]),
		);
		expect(aliases).toEqual([]);
		const verifier = await mysql.createConnection(databaseUrl);
		const [remaining] = await verifier.query<
			Array<{ userId: string } & RowDataPacket>
		>("SELECT userId FROM product_analytics_outbox");
		await verifier.end();
		expect(remaining.map(({ userId }) => userId)).toEqual(["shared-user-b"]);
	});

	it("does not spread a deleted user's tombstone to a live organization", async () => {
		const { createProductEventRows } = await import("@cap/analytics");
		const { db } = await import("@cap/database");
		const { productAnalyticsIdentityHash } = await import("@cap/web-backend");
		const { persistProductAnalyticsEvent } = await import(
			"@/lib/analytics/product-event-outbox"
		);
		await runRepo((repo) =>
			repo.discardPendingEvents({ userId: "deleted-user" }),
		);
		const suppressed = await db().transaction((tx) =>
			persistProductAnalyticsEvent(tx, {
				eventId: "deleted-user:late",
				eventName: "user_signed_up",
				occurredAt: new Date().toISOString(),
				anonymousId: "deleted-user:new-alias",
				platform: "web",
				userId: "deleted-user",
				organizationId: "live-organization",
			}),
		);
		expect(suppressed.status).toBe("suppressed");
		const [blockedCollectorRow] = createProductEventRows(
			[
				{
					anonymousId: "deleted-user:new-alias",
					eventId: "deleted-user:late-client-event",
					eventName: "page_view",
					occurredAt: "2026-07-31T12:00:00.000Z",
					platform: "web",
					properties: {
						hostname: "cap.test",
						is_session_entry: true,
						session_started_at: "2026-07-31T12:00:00.000Z",
					},
				},
			],
			{
				hostname: "cap.test",
				receivedAt: "2026-07-31T12:00:01.000Z",
				source: "client",
				userId: "deleted-user",
			},
		);
		if (!blockedCollectorRow)
			throw new Error("Expected a blocked collector row");
		await expect(appendCollectorRows([blockedCollectorRow])).resolves.toEqual({
			acceptedEventIds: [],
			rejectedEventIds: [blockedCollectorRow.event_id],
		});
		const accepted = await db().transaction((tx) =>
			persistProductAnalyticsEvent(tx, {
				eventId: "live-user:signup",
				eventName: "user_signed_up",
				occurredAt: new Date().toISOString(),
				anonymousId: "live-user:alias",
				platform: "web",
				userId: "live-user",
				organizationId: "live-organization",
			}),
		);
		expect(accepted.status).not.toBe("suppressed");
		const verifier = await mysql.createConnection(databaseUrl);
		const [organizationState] = await verifier.query<
			Array<{ blockedAt: Date | null } & RowDataPacket>
		>(
			"SELECT blockedAt FROM product_analytics_identity_state WHERE identityHash = ?",
			[productAnalyticsIdentityHash("organization", "live-organization")],
		);
		await verifier.end();
		expect(organizationState[0]?.blockedAt).toBeNull();
	});

	it("keeps first-payload ownership after delivery payload cleanup", async () => {
		const { db } = await import("@cap/database");
		const { getProductAnalyticsOutboxHealth, persistProductAnalyticsEvent } =
			await import("@/lib/analytics/product-event-outbox");
		const eventId = "receipt-first-write-alpha";
		const first = await db().transaction((tx) =>
			persistProductAnalyticsEvent(tx, {
				eventId,
				eventName: "user_signed_up",
				occurredAt: "2026-07-01T12:00:00.000Z",
				anonymousId: "receipt-alias",
				platform: "web",
				userId: "receipt-user",
				organizationId: "receipt-org",
			}),
		);
		const verifier = await mysql.createConnection(databaseUrl);
		await verifier.query(
			"DELETE FROM product_analytics_outbox WHERE eventId = ?",
			[eventId],
		);
		await verifier.query(
			"UPDATE product_analytics_event_receipts SET firstSeenAt = DATE_SUB(NOW(), INTERVAL 32 DAY), lastSeenAt = DATE_SUB(NOW(), INTERVAL 32 DAY)",
		);
		await verifier.end();
		const replay = await db().transaction((tx) =>
			persistProductAnalyticsEvent(tx, {
				eventId,
				eventName: "user_signed_up",
				occurredAt: "2026-07-01T12:00:01.000Z",
				anonymousId: "receipt-alias",
				platform: "web",
				userId: "receipt-user",
				organizationId: "receipt-org",
			}),
		);
		expect(first.payloadConflict).toBe(false);
		expect(replay).toMatchObject({ payloadConflict: true, status: "conflict" });
		const health = await getProductAnalyticsOutboxHealth();
		expect(health.healthy).toBe(false);
		expect(health.receiptPayloadConflictEvents).toBe(1);
		expect(health.receiptPayloadConflictAttempts).toBe(1);
	});

	it("releases invite locks before provider I/O and fails closed without email configuration", async () => {
		const verifier = await mysql.createConnection(databaseUrl);
		await verifier.query(
			"INSERT INTO organizations (id, name) VALUES ('orginvitealpha', 'Invite Org')",
		);
		await verifier.query(`
			INSERT INTO organization_invites (
				id, organizationId, invitedEmail, invitedEmailNormalized,
				invitedByUserId, role, emailDeliveryState, emailDeliveryNextAttemptAt
			) VALUES (
				'invitealpha', 'orginvitealpha', 'invitee@example.test',
				'invitee@example.test', 'inviteralpha', 'member', 'pending', NOW()
			)
		`);
		let releaseProvider: ((value: unknown) => void) | undefined;
		inviteMocks.sendEmail.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseProvider = resolve;
				}),
		);
		const { deliverOrganizationInvite } = await import(
			"@/lib/organization-invite-delivery"
		);
		const delivery = deliverOrganizationInvite("invitealpha");
		while (!releaseProvider) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await verifier.beginTransaction();
		await verifier.query("SET SESSION innodb_lock_wait_timeout = 1");
		await verifier.query(
			"SELECT id FROM organization_invites WHERE id = 'invitealpha' FOR UPDATE",
		);
		await verifier.rollback();
		releaseProvider({ data: { id: "provider-message-alpha" }, error: null });
		await expect(delivery).resolves.toEqual({ status: "sent" });

		await verifier.query(`
			INSERT INTO organization_invites (
				id, organizationId, invitedEmail, invitedEmailNormalized,
				invitedByUserId, role, emailDeliveryState, emailDeliveryNextAttemptAt
			) VALUES (
				'invitebeta', 'orginvitealpha', 'second@example.test',
				'second@example.test', 'inviteralpha', 'member', 'pending', NOW()
			)
		`);
		inviteMocks.environment.RESEND_API_KEY = "";
		await expect(deliverOrganizationInvite("invitebeta")).resolves.toEqual({
			status: "deferred",
		});
		const [deferred] = await verifier.query<
			Array<
				{
					emailDeliveryState: string;
					emailDeliveryErrorCode: string;
				} & RowDataPacket
			>
		>(
			"SELECT emailDeliveryState, emailDeliveryErrorCode FROM organization_invites WHERE id = 'invitebeta'",
		);
		expect(deferred[0]).toMatchObject({
			emailDeliveryState: "pending",
			emailDeliveryErrorCode: "provider_send_failed",
		});
		inviteMocks.environment.RESEND_API_KEY = "staging-resend-key";
		await verifier.end();
	});
});
