import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

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
	database: Connection,
): Promise<LoopsHealth> {
	const [rows] = await database.query<RowDataPacket[]>(
		{
			sql: "SELECT COUNT(*) AS totalJobs,COALESCE(SUM(nextAttemptAt<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 5 MINUTE) AND COALESCE(lastError,'') NOT IN (?)),0) AS overdueJobs,COALESCE(SUM(failures>=3 AND COALESCE(lastError,'') NOT IN (?)),0) AS failingJobs FROM loops_sync_jobs",
			timeout: 10_000,
		},
		[expectedHolds, expectedHolds],
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
	const database = await mysql.createConnection({
		uri: process.env.DATABASE_URL,
		timezone: "Z",
		connectTimeout: 10_000,
	});
	try {
		return await readQueueHealth(database);
	} finally {
		await database.end();
	}
}
