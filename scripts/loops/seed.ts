import { parseArgs } from "node:util";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { loopsRuntimeConfig } from "../../packages/database/loops/worker";

const { values } = parseArgs({
	options: { apply: { type: "boolean", default: false } },
});
const config = loopsRuntimeConfig(process.env);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (values.apply && process.env.LOOPS_SYNC_ENABLED !== "true")
	throw new Error("LOOPS_SYNC_ENABLED=true is required");
const database = await mysql.createConnection(process.env.DATABASE_URL);
try {
	const eligibility = `(u.emailVerified IS NOT NULL OR EXISTS (SELECT 1 FROM accounts a WHERE a.userId=u.id)) ${config.allowedEmails ? "AND u.email IN (?)" : ""}`;
	const params = config.allowedEmails ? [[...config.allowedEmails]] : [];
	const [counts] = await database.query<(RowDataPacket & { total: number })[]>(
		`SELECT COUNT(*) AS total FROM users u WHERE ${eligibility}`,
		params,
	);
	console.log(
		JSON.stringify({
			mode: values.apply ? "seed sync jobs" : "dry run",
			users: counts[0]?.total,
			enrollsContacts: false,
		}),
	);
	if (values.apply)
		await database.query(
			`INSERT INTO loops_sync_jobs (userId,nextAttemptAt) SELECT u.id,UTC_TIMESTAMP() FROM users u WHERE ${eligibility} ON DUPLICATE KEY UPDATE revision=revision+1,nextAttemptAt=UTC_TIMESTAMP()`,
			params,
		);
} finally {
	await database.end();
}
