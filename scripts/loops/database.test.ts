import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { enqueueLoopsSync } from "../../packages/database/loops/queue";
import { claimJob, deferJob } from "../../packages/database/loops/worker";
import { loopsSyncJobs } from "../../packages/database/schema";

const url = process.env.LOOPS_TEST_DATABASE_URL;
const ids = Array.from({ length: 6 }, () =>
	User.UserId.make(randomUUID().replaceAll("-", "").slice(0, 15)),
);

describe.skipIf(!url)("durable Loops queue on an isolated database", () => {
	let database: Connection;
	let other: Connection;
	const previousEnabled = process.env.LOOPS_SYNC_ENABLED;
	beforeAll(async () => {
		if (!url || process.env.LOOPS_TEST_BRANCH !== "loops-reliability-20260911")
			throw new Error("Pass the isolated Loops test branch explicitly");
		database = await mysql.createConnection({
			uri: url,
			timezone: "Z",
			dateStrings: true,
		});
		other = await mysql.createConnection({
			uri: url,
			timezone: "Z",
			dateStrings: true,
		});
		process.env.LOOPS_SYNC_ENABLED = "true";
	});
	afterAll(async () => {
		if (previousEnabled === undefined) delete process.env.LOOPS_SYNC_ENABLED;
		else process.env.LOOPS_SYNC_ENABLED = previousEnabled;
		if (database) {
			await database.query("DELETE FROM loops_sync_jobs WHERE userId IN (?)", [
				ids,
			]);
			await database.end();
		}
		if (other) await other.end();
	});

	test("rolling back a signup rolls back its queued update", async () => {
		const orm = drizzle(database);
		await expect(
			orm.transaction(async (tx) => {
				await enqueueLoopsSync(tx, ids[0]);
				throw new Error("abort_signup");
			}),
		).rejects.toThrow("abort_signup");
		expect(
			await orm
				.select()
				.from(loopsSyncJobs)
				.where(eq(loopsSyncJobs.userId, ids[0])),
		).toHaveLength(0);
	});

	test("overlapping runners cannot claim the same update", async () => {
		await enqueueLoopsSync(drizzle(database), ids[1]);
		await enqueueLoopsSync(drizzle(database), ids[1]);
		const [first, second] = await Promise.all([
			claimJob(database, "runner-one", [ids[1]]),
			claimJob(other, "runner-two", [ids[1]]),
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect((first ?? second)?.revision).toBe(2);
	});

	test("an interrupted worker's expired lease becomes claimable", async () => {
		await database.execute(
			"UPDATE loops_sync_jobs SET leaseUntil=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE userId=?",
			[ids[1]],
		);
		const claimed = await claimJob(other, "replacement-runner", [ids[1]]);
		expect(claimed?.userId).toBe(ids[1]);
	});

	test("an invite queued during a sync remains due after the older update completes", async () => {
		await enqueueLoopsSync(drizzle(database), ids[2]);
		const old = await claimJob(database, "in-flight", [ids[2]]);
		if (!old) throw new Error("Test job was not claimed");
		await enqueueLoopsSync(drizzle(other), ids[2]);
		await database.execute(
			"UPDATE loops_sync_jobs SET nextAttemptAt=CASE WHEN revision=? THEN DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY) ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
			[old.revision, ids[2], "in-flight"],
		);
		const next = await claimJob(other, "newer-update", [ids[2]]);
		expect(next?.revision).toBe(old.revision + 1);
	});

	test("the due query uses the due-time index", async () => {
		const [plan] = await database.query<RowDataPacket[]>(
			"EXPLAIN SELECT * FROM loops_sync_jobs WHERE nextAttemptAt<=UTC_TIMESTAMP() AND (leaseUntil IS NULL OR leaseUntil<UTC_TIMESTAMP()) ORDER BY nextAttemptAt LIMIT 1",
		);
		expect(
			plan.some((row) =>
				String(row.possible_keys).includes("loops_sync_due_idx"),
			),
		).toBe(true);
	});

	test("new invite work stays immediately due when an older attempt fails", async () => {
		await enqueueLoopsSync(drizzle(database), ids[3]);
		const old = await claimJob(database, "failing-attempt", [ids[3]]);
		if (!old) throw new Error("Test job was not claimed");
		await enqueueLoopsSync(drizzle(other), ids[3], true);
		await deferJob(
			database,
			old,
			"failing-attempt",
			"loops_http_429",
			new Date(Date.now() + 60 * 60_000),
		);
		const next = await claimJob(other, "new-invite", [ids[3]]);
		expect(next?.revision).toBe(old.revision + 1);
		expect(next?.failures).toBe(0);
		expect(next?.teammateJoinedAt).toBeTruthy();
	});

	test("unchanged failed work backs off and an expired lease cannot overwrite its replacement", async () => {
		await enqueueLoopsSync(drizzle(database), ids[4]);
		const old = await claimJob(database, "original-attempt", [ids[4]]);
		if (!old) throw new Error("Test job was not claimed");
		await deferJob(
			database,
			old,
			"original-attempt",
			"loops_http_429",
			new Date(Date.now() + 60 * 60_000),
		);
		expect(await claimJob(other, "too-early", [ids[4]])).toBeUndefined();
		await enqueueLoopsSync(drizzle(other), ids[4]);
		const replacement = await claimJob(other, "replacement-attempt", [ids[4]]);
		if (!replacement) throw new Error("Replacement was not claimed");
		await deferJob(
			database,
			old,
			"original-attempt",
			"sync_failed",
			new Date(),
		);
		const [rows] = await database.execute<RowDataPacket[]>(
			"SELECT leaseToken,revision FROM loops_sync_jobs WHERE userId=?",
			[ids[4]],
		);
		expect(rows[0].leaseToken).toBe("replacement-attempt");
		expect(rows[0].revision).toBe(replacement.revision);
	});
});
