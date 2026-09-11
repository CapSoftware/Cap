import type { User } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { loopsSyncJobs } from "../schema";

export async function enqueueLoopsSync(
	database: Pick<MySql2Database, "insert">,
	userId: User.UserId,
	teammateJoined = false,
) {
	if (process.env.LOOPS_SYNC_ENABLED !== "true") return;
	await database
		.insert(loopsSyncJobs)
		.values({
			userId,
			nextAttemptAt: sql`UTC_TIMESTAMP()`,
			...(teammateJoined ? { teammateJoinedAt: sql`UTC_TIMESTAMP()` } : {}),
		})
		.onDuplicateKeyUpdate({
			set: {
				revision: sql`${loopsSyncJobs.revision} + 1`,
				nextAttemptAt: sql`UTC_TIMESTAMP()`,
				...(teammateJoined ? { teammateJoinedAt: sql`UTC_TIMESTAMP()` } : {}),
			},
		});
}
