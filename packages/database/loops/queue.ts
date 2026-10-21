import type { User } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { loopsSyncJobs } from "../schema";

export async function enqueueLoopsSync(
	database: Pick<NodePgDatabase, "insert">,
	userId: User.UserId,
	teammateJoined = false,
) {
	if (process.env.LOOPS_SYNC_ENABLED !== "true") return;
	await database
		.insert(loopsSyncJobs)
		.values({
			userId,
			nextAttemptAt: sql`timezone('utc', now())`,
			...(teammateJoined
				? { teammateJoinedAt: sql`timezone('utc', now())` }
				: {}),
		})
		.onConflictDoUpdate({
			target: loopsSyncJobs.userId,
			set: {
				revision: sql`${loopsSyncJobs.revision} + 1`,
				nextAttemptAt: sql`timezone('utc', now())`,
				failures: 0,
				lastError: null,
				...(teammateJoined
					? { teammateJoinedAt: sql`timezone('utc', now())` }
					: {}),
			},
		});
}
