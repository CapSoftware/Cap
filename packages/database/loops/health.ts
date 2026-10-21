import type pg from "pg";
import { connectCapDatabase } from "./connection";

export type LoopsHealth = {
	healthy: boolean;
	checkedAt: string;
	totalJobs: number;
	overdueJobs: number;
	failingJobs: number;
};

const expectedHolds = [
	"signup_not_complete",
	"user_removed",
	"identity_change_held",
	"remote_contact_removed",
];

export async function readQueueHealth(
	database: pg.ClientBase,
): Promise<LoopsHealth> {
	const { rows } = await database.query(
		`SELECT COUNT(*) AS "totalJobs",
			COALESCE(SUM(CASE WHEN "nextAttemptAt" < timezone('utc', now()) - interval '5 minutes' AND COALESCE("lastError", '') <> ALL($1::text[]) THEN 1 ELSE 0 END), 0) AS "overdueJobs",
			COALESCE(SUM(CASE WHEN failures >= 3 AND COALESCE("lastError", '') <> ALL($1::text[]) THEN 1 ELSE 0 END), 0) AS "failingJobs"
		FROM loops_sync_jobs`,
		[expectedHolds],
	);
	const totalJobs = Number(rows[0]?.totalJobs);
	const overdueJobs = Number(rows[0]?.overdueJobs);
	const failingJobs = Number(rows[0]?.failingJobs);
	if (
		![totalJobs, overdueJobs, failingJobs].every(
			(value) => Number.isSafeInteger(value) && value >= 0,
		)
	)
		throw new Error("invalid_queue_health");
	return {
		healthy: totalJobs > 0 && overdueJobs === 0 && failingJobs === 0,
		checkedAt: new Date().toISOString(),
		totalJobs,
		overdueJobs,
		failingJobs,
	};
}

export async function readLoopsHealth(): Promise<LoopsHealth> {
	if (
		process.env.LOOPS_SYNC_ENABLED !== "true" ||
		process.env.LOOPS_SYNC_MODE !== "production" ||
		process.env.LOOPS_ENROLLMENT_ENABLED !== "true"
	)
		return {
			healthy: false,
			checkedAt: new Date().toISOString(),
			totalJobs: 0,
			overdueJobs: 0,
			failingJobs: 0,
		};
	if (!process.env.DATABASE_URL) throw new Error("missing_database_url");
	const database = await connectCapDatabase(process.env.DATABASE_URL);
	try {
		return await readQueueHealth(database);
	} finally {
		await database.end();
	}
}
