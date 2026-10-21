import { parseArgs } from "node:util";
import { connectCapDatabase } from "../../packages/database/loops/connection";
import { loopsRuntimeConfig } from "../../packages/database/loops/worker";

const { values } = parseArgs({
	options: { apply: { type: "boolean", default: false } },
});
const config = loopsRuntimeConfig(process.env);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (values.apply && process.env.LOOPS_SYNC_ENABLED !== "true")
	throw new Error("LOOPS_SYNC_ENABLED=true is required");
const database = await connectCapDatabase(process.env.DATABASE_URL);
try {
	const eligibility = `(u."emailVerified" IS NOT NULL OR EXISTS (SELECT 1 FROM accounts a WHERE a."userId"=u.id)) ${config.allowedEmails ? "AND lower(u.email) = ANY($1::text[])" : ""}`;
	const params = config.allowedEmails ? [[...config.allowedEmails]] : [];
	const { rows: counts } = await database.query<{ total: number }>(
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
			`INSERT INTO loops_sync_jobs ("userId","nextAttemptAt") SELECT u.id,timezone('utc', now()) FROM users u WHERE ${eligibility} ON CONFLICT ("userId") DO UPDATE SET revision=loops_sync_jobs.revision+1,"nextAttemptAt"=timezone('utc', now())`,
			params,
		);
} finally {
	await database.end();
}
