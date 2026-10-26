import type {
	Connection,
	ResultSetHeader,
	RowDataPacket,
} from "mysql2/promise";
import { placeholders } from "./sql";

export type Job = RowDataPacket & {
	userId: string;
	revision: number;
	failures: number;
	syncedEmail: string | null;
	lastSyncedAt: string | null;
	profileHash: string | null;
	teammateJoinedAt: string | null;
};

export async function claimJobs(
	database: Connection,
	token: string,
	allowedUserIds: string[] | null,
	limit: number,
) {
	await database.beginTransaction();
	try {
		const [jobs] = await database.query<Job[]>(
			`SELECT * FROM loops_sync_jobs WHERE nextAttemptAt<=UTC_TIMESTAMP() AND (leaseUntil IS NULL OR leaseUntil<UTC_TIMESTAMP()) ${allowedUserIds ? "AND userId IN (?)" : ""} ORDER BY nextAttemptAt LIMIT ? FOR UPDATE SKIP LOCKED`,
			allowedUserIds ? [allowedUserIds, limit] : [limit],
		);
		if (jobs.length)
			await database.execute(
				`UPDATE loops_sync_jobs SET leaseToken=?,leaseUntil=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 MINUTE) WHERE userId IN (${placeholders(jobs.length)})`,
				[token, ...jobs.map((job) => job.userId)],
			);
		await database.commit();
		return jobs;
	} catch (error) {
		await database.rollback();
		throw error;
	}
}

export async function renewLease(
	database: Connection,
	job: Pick<Job, "userId">,
	token: string,
) {
	const [result] = await database.execute<ResultSetHeader>(
		"UPDATE loops_sync_jobs SET leaseUntil=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 MINUTE) WHERE userId=? AND leaseToken=?",
		[job.userId, token],
	);
	return result.affectedRows > 0;
}

export async function releaseJobs(
	database: Connection,
	token: string,
	userIds: string[],
) {
	await database.execute(
		`UPDATE loops_sync_jobs SET leaseToken=NULL,leaseUntil=NULL WHERE leaseToken=? AND userId IN (${placeholders(userIds.length)})`,
		[token, ...userIds],
	);
}

export async function deferJob(
	database: Connection,
	job: Pick<Job, "userId" | "revision">,
	token: string,
	reason: string,
	nextAttemptAt: Date,
) {
	await database.execute(
		"UPDATE loops_sync_jobs SET failures=CASE WHEN revision=? THEN failures+1 ELSE 0 END,lastError=CASE WHEN revision=? THEN ? ELSE NULL END,nextAttemptAt=CASE WHEN revision=? THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
		[
			job.revision,
			job.revision,
			reason,
			job.revision,
			nextAttemptAt,
			job.userId,
			token,
		],
	);
}

export async function completeUnchangedJob(
	database: Connection,
	job: Pick<Job, "userId" | "revision">,
	token: string,
	nextAttemptAt: Date,
) {
	await database.execute(
		"UPDATE loops_sync_jobs SET failures=0,lastError=NULL,nextAttemptAt=CASE WHEN revision=? THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
		[job.revision, nextAttemptAt, job.userId, token],
	);
}

export async function completeUnchangedJobs(
	database: Connection,
	token: string,
	jobs: { job: Pick<Job, "userId" | "revision">; nextAttemptAt: Date }[],
) {
	const groups = new Map<number, typeof jobs>();
	for (const entry of jobs) {
		const key = entry.nextAttemptAt.getTime();
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	}
	for (const group of groups.values())
		await database.execute(
			`UPDATE loops_sync_jobs SET failures=0,lastError=NULL,nextAttemptAt=CASE WHEN (userId,revision) IN (${group.map(() => "(?,?)").join(",")}) THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE leaseToken=? AND userId IN (${placeholders(group.length)})`,
			[
				...group.flatMap(({ job }) => [job.userId, job.revision]),
				group[0].nextAttemptAt,
				token,
				...group.map(({ job }) => job.userId),
			],
		);
}
