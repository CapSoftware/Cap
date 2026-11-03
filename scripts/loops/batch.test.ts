import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
	claimJobs,
	completeUnchangedJobs,
	releaseJobs,
	renewLease,
} from "../../packages/database/loops/jobs";
import {
	readLoopsProfile,
	readLoopsProfiles,
} from "../../packages/database/loops/sources";

const url = process.env.LOOPS_ACTIVATION_READONLY_TEST_URL;

type Row = (string | number | null)[];

function fixtureRows(columns: string[], rows: Row[]) {
	return rows.length
		? rows
				.map(
					() =>
						`SELECT ${columns
							.map(
								(column) =>
									`CAST(? AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_0900_ai_ci AS ${column}`,
							)
							.join(",")}`,
				)
				.join(" UNION ALL ")
		: `SELECT ${columns.map((column) => `NULL AS ${column}`).join(",")} WHERE FALSE`;
}

const tables: Record<string, [string[], Row[]]> = {
	users: [
		[
			"id",
			"email",
			"name",
			"lastName",
			"emailVerified",
			"stripeCustomerId",
			"stripeSubscriptionStatus",
			"thirdPartyStripeSubscriptionId",
			"inviteQuota",
			"created_at",
			"defaultOrgId",
			"marketingOrigin",
		],
		[
			[
				"legacy",
				"legacy@example.com",
				"Legacy",
				null,
				"2026-01-05 10:00:00",
				"cus_legacy",
				"active",
				null,
				"3",
				"2026-01-05 10:00:00",
				"org-legacy",
				"independent",
			],
			[
				"recent",
				"Recent@Example.com",
				"Recent",
				"Person",
				null,
				null,
				null,
				null,
				"1",
				"2026-10-01 10:00:00",
				"org-recent",
				"unknown",
			],
			[
				"quiet",
				"quiet@example.com",
				null,
				null,
				null,
				null,
				null,
				null,
				"1",
				"2026-10-02 10:00:00",
				null,
				"unknown",
			],
			[
				"mixedcase",
				"mixed@example.com",
				"Mixed",
				null,
				"2026-03-01 10:00:00",
				null,
				"canceled",
				null,
				"1",
				"2026-03-01 10:00:00",
				null,
				"unknown",
			],
			[
				"accent",
				"José@example.com",
				"José",
				null,
				null,
				null,
				null,
				"sub_partner",
				"1",
				"2026-02-01 10:00:00",
				null,
				"teammate",
			],
		],
	],
	accounts: [
		["userId", "provider"],
		[
			["legacy", "google"],
			["accent", "workos"],
		],
	],
	organization_invites: [
		["invitedEmail", "status"],
		[
			["quiet@example.com", "pending"],
			["recent@example.com", "accepted"],
		],
	],
	organization_members: [
		["userId", "organizationId", "hasProSeat"],
		[
			["legacy", "org-legacy", "0"],
			["legacy", "org-shared", "1"],
			["MIXEDCASE", "org-shared", "0"],
			["recent", "org-recent", "0"],
		],
	],
	organizations: [
		["id", "ownerId", "tombstoneAt", "workosConnectionId", "createdAt"],
		[
			["org-legacy", "legacy", null, null, "2026-01-05 10:00:00"],
			["org-shared", "someone", "2026-06-01 10:00:00", "conn", "2026-01-01"],
			["org-recent", "recent", null, null, "2026-10-01 10:00:00"],
		],
	],
	videos: [
		[
			"id",
			"ownerId",
			"isScreenshot",
			"duration",
			"source",
			"jobStatus",
			"createdAt",
			"firstViewEmailSentAt",
			"public",
		],
		[
			[
				"v-legacy-private",
				"legacy",
				"0",
				"12",
				'{"type":"MediaConvert"}',
				null,
				"2026-01-06 10:00:00",
				null,
				"0",
			],
			[
				"v-legacy-public",
				"legacy",
				"0",
				"30",
				'{"type":"MediaConvert"}',
				"COMPLETE",
				"2026-01-07 10:00:00",
				null,
				"1",
			],
			[
				"v-recent-shared",
				"recent",
				"0",
				"45",
				'{"type":"desktopMP4","outputKey":"recent/v/result.mp4"}',
				null,
				"2026-10-02 10:00:00",
				"2026-10-02 12:00:00",
				"1",
			],
			[
				"v-recent-uploading",
				"recent",
				"0",
				"20",
				'{"type":"webMP4"}',
				null,
				"2026-10-03 10:00:00",
				null,
				"1",
			],
			[
				"v-recent-shot",
				"recent",
				"1",
				"0",
				'{"type":"desktopMP4"}',
				null,
				"2026-10-04 10:00:00",
				null,
				"1",
			],
			[
				"v-mixed",
				"MIXEDCASE",
				"0",
				"9",
				'{"type":"desktopSegments"}',
				null,
				"2026-03-02 10:00:00",
				null,
				"1",
			],
		],
	],
	video_uploads: [["video_id"], [["v-recent-uploading"]]],
	video_processing_jobs: [
		["video_id", "state"],
		[["v-recent-shared", "verified"]],
	],
	user: [
		["id", "email"],
		[
			["license-legacy", "legacy@example.com"],
			["license-recent", "recent@example.com"],
			["license-accent", "jose@example.com"],
		],
	],
	commercialLicenses: [
		["userId", "subscriptionActive", "nextRenewalDate"],
		[
			["license-legacy", "1", "2030-01-01 00:00:00"],
			["license-recent", "0", null],
			["license-accent", "1", "2020-01-01 00:00:00"],
		],
	],
	selfHostedLicenses: [
		["userId", "subscriptionActive", "nextRenewalDate"],
		[["license-recent", "1", "2030-01-01 00:00:00"]],
	],
};

const cte = `WITH ${Object.entries(tables)
	.map(
		([name, [columns, rows]]) => `${name} AS (${fixtureRows(columns, rows)})`,
	)
	.join(", ")}`;
const cteValues = Object.values(tables).flatMap(([, rows]) => rows.flat());

describe.skipIf(!url)("batched Loops source reads", () => {
	let database: Connection;
	let fixtures: Connection;
	const statements: string[] = [];
	beforeAll(async () => {
		if (!url) throw new Error("Missing read-only test connection");
		database = await mysql.createConnection({
			uri: url,
			dateStrings: true,
			timezone: "Z",
		});
		fixtures = {
			execute: (sql: string, values: unknown[]) => {
				statements.push(sql);
				return database.query(`${cte} ${sql}`, [...cteValues, ...values]);
			},
		} as unknown as Connection;
	});
	afterAll(async () => {
		await database?.end();
	});

	const withoutClock = (
		profile: Awaited<ReturnType<typeof readLoopsProfile>>,
	) =>
		profile && {
			...profile,
			input: { ...profile.input, now: undefined },
		};

	test("every user reads the same profile as the single-user path", async () => {
		const requested = [
			"legacy",
			"recent",
			"quiet",
			"MixedCase",
			"accent",
			"missing",
		];
		const batch = await readLoopsProfiles(fixtures, fixtures, requested);
		for (const userId of requested)
			expect(withoutClock(batch.get(userId) ?? null)).toEqual(
				withoutClock(await readLoopsProfile(fixtures, fixtures, userId)),
			);
		expect([...batch.keys()].sort()).toEqual(
			requested.filter((userId) => userId !== "missing").sort(),
		);
	});

	test("the fixtures exercise every source", async () => {
		const batch = await readLoopsProfiles(fixtures, fixtures, [
			"legacy",
			"recent",
			"quiet",
			"MixedCase",
			"accent",
		]);
		const legacy = batch.get("legacy")?.input;
		expect(legacy?.memberships.map((member) => member.organizationId)).toEqual([
			"org-legacy",
			"org-shared",
		]);
		expect([legacy?.hasVideo, legacy?.hasSharedVideo]).toEqual([true, true]);
		expect(legacy?.licenses.map((license) => license.kind)).toEqual([
			"desktop",
		]);
		const recent = batch.get("recent")?.input;
		expect(recent?.licenses.map((license) => license.kind)).toEqual([
			"desktop",
			"selfhosted",
		]);
		expect([
			recent?.hasVideo,
			recent?.hasSharedVideo,
			recent?.hasPendingUpload,
		]).toEqual([true, true, true]);
		expect(recent?.lastActivationNotificationAt).toBe("2026-10-03 10:05:00");
		const quiet = batch.get("quiet");
		expect(quiet?.pendingInvite).toBe(true);
		expect(quiet?.input.lastActivationNotificationAt).toBeNull();
		expect(batch.get("MixedCase")?.input.memberships).toHaveLength(1);
		expect(batch.get("MixedCase")?.input.hasVideo).toBe(true);
		expect(batch.get("accent")?.input.licenses).toHaveLength(1);
		expect(batch.get("accent")?.input.sso).toBe(true);
	});

	test("a batch costs one statement per source table", async () => {
		statements.length = 0;
		await readLoopsProfiles(fixtures, fixtures, [
			"legacy",
			"recent",
			"quiet",
			"MixedCase",
			"accent",
		]);
		expect(statements).toHaveLength(5);
		statements.length = 0;
		await readLoopsProfiles(fixtures, fixtures, ["legacy", "MixedCase"]);
		expect(statements).toHaveLength(4);
		statements.length = 0;
		expect(
			(await readLoopsProfiles(fixtures, fixtures, ["missing"])).size,
		).toBe(0);
		expect(statements).toHaveLength(1);
	});
});

describe.skipIf(!url)("batched Loops job leases", () => {
	let database: Connection;
	beforeAll(async () => {
		if (!url) throw new Error("Missing read-only test connection");
		database = await mysql.createConnection({
			uri: url,
			dateStrings: true,
			timezone: "Z",
		});
		await database.query(
			"CREATE TEMPORARY TABLE loops_sync_jobs (userId varchar(15) NOT NULL, revision int NOT NULL DEFAULT 1, nextAttemptAt datetime NOT NULL, leaseToken varchar(36) DEFAULT NULL, leaseUntil datetime DEFAULT NULL, failures int NOT NULL DEFAULT 0, lastError varchar(64) DEFAULT NULL, profileHash varchar(64) DEFAULT NULL, syncedEmail varchar(255) DEFAULT NULL, lastSyncedAt datetime DEFAULT NULL, teammateJoinedAt datetime DEFAULT NULL, PRIMARY KEY (userId), KEY loops_sync_due_idx (nextAttemptAt))",
		);
		await database.query(
			`INSERT INTO loops_sync_jobs (userId,nextAttemptAt,leaseToken,leaseUntil,failures,lastError) VALUES
			('failing',UTC_TIMESTAMP()-INTERVAL 4 MINUTE,NULL,NULL,3,'loops_http_500'),
			('first',UTC_TIMESTAMP()-INTERVAL 3 MINUTE,NULL,NULL,0,NULL),
			('second',UTC_TIMESTAMP()-INTERVAL 2 MINUTE,NULL,NULL,0,NULL),
			('third',UTC_TIMESTAMP()-INTERVAL 1 MINUTE,NULL,NULL,0,NULL),
			('expired',UTC_TIMESTAMP()-INTERVAL 30 SECOND,'old',UTC_TIMESTAMP()-INTERVAL 1 SECOND,0,NULL),
			('leased',UTC_TIMESTAMP()-INTERVAL 5 MINUTE,'other',UTC_TIMESTAMP()+INTERVAL 1 MINUTE,0,NULL),
			('future',UTC_TIMESTAMP()+INTERVAL 1 HOUR,NULL,NULL,0,NULL)`,
		);
	});
	afterAll(async () => {
		await database?.end();
	});

	const job = async (userId: string) => {
		const [[row]] = await database.query<RowDataPacket[]>(
			"SELECT *, leaseUntil>UTC_TIMESTAMP() AS leaseActive, TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),nextAttemptAt) AS dueIn FROM loops_sync_jobs WHERE userId=?",
			[userId],
		);
		return row;
	};

	test("claims due jobs in order and leases them together", async () => {
		const jobs = await claimJobs(database, "batch", null, 3);
		expect(jobs.map((claimed) => claimed.userId)).toEqual([
			"failing",
			"first",
			"second",
		]);
		for (const userId of ["failing", "first", "second"])
			expect(await job(userId)).toMatchObject({
				leaseToken: "batch",
				leaseActive: 1,
			});
		expect(
			(await claimJobs(database, "rest", null, 50)).map(
				(claimed) => claimed.userId,
			),
		).toEqual(["third", "expired"]);
		expect(await claimJobs(database, "none", null, 50)).toEqual([]);
	});

	test("completes unchanged jobs with the revision guard", async () => {
		await database.query(
			"UPDATE loops_sync_jobs SET revision=revision+1 WHERE userId='first'",
		);
		const wholeSecond = Math.floor(Date.now() / 1000) * 1000;
		const day = new Date(wholeSecond + 24 * 60 * 60_000);
		const hour = new Date(wholeSecond + 60 * 60_000);
		await completeUnchangedJobs(database, "batch", [
			{ job: { userId: "failing", revision: 1 }, nextAttemptAt: day },
			{ job: { userId: "first", revision: 1 }, nextAttemptAt: day },
			{ job: { userId: "second", revision: 1 }, nextAttemptAt: hour },
			{ job: { userId: "third", revision: 1 }, nextAttemptAt: hour },
		]);
		expect(await job("failing")).toMatchObject({
			failures: 0,
			lastError: null,
			leaseToken: null,
			leaseUntil: null,
		});
		expect((await job("failing")).dueIn).toBeGreaterThan(23 * 60 * 60);
		expect((await job("first")).dueIn).toBeLessThanOrEqual(0);
		expect((await job("first")).leaseToken).toBeNull();
		expect((await job("second")).dueIn).toBeGreaterThan(59 * 60);
		expect((await job("second")).dueIn).toBeLessThanOrEqual(60 * 60);
		expect(await job("third")).toMatchObject({ leaseToken: "rest" });
		expect((await job("third")).dueIn).toBeLessThanOrEqual(0);
	});

	test("renews and releases only leases it holds", async () => {
		expect(await renewLease(database, { userId: "third" }, "rest")).toBe(true);
		expect(await renewLease(database, { userId: "third" }, "rest")).toBe(true);
		expect(await renewLease(database, { userId: "third" }, "batch")).toBe(
			false,
		);
		await releaseJobs(database, "batch", ["third", "expired"]);
		expect((await job("third")).leaseToken).toBe("rest");
		await releaseJobs(database, "rest", ["third", "expired"]);
		expect(await job("third")).toMatchObject({
			leaseToken: null,
			leaseUntil: null,
		});
		expect(
			(await claimJobs(database, "again", ["expired", "future"], 50)).map(
				(claimed) => claimed.userId,
			),
		).toEqual(["expired"]);
	});
});
