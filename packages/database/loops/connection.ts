import pg from "pg";

const TIMESTAMP_OID = pg.types.builtins.TIMESTAMP;

// Timestamps stay as `YYYY-MM-DD HH:MM:SS[.ffffff]` strings (UTC) so the
// lifecycle code never depends on the process timezone.
export async function connectCapDatabase(connectionString: string) {
	const client = new pg.Client({
		connectionString,
		connectionTimeoutMillis: 10_000,
		query_timeout: 10_000,
		types: {
			getTypeParser: ((oid: number, format?: "text" | "binary") =>
				oid === TIMESTAMP_OID
					? (value: string) => value
					: pg.types.getTypeParser(oid, format as "text")) as never,
		},
	});
	await client.connect();
	return client;
}

export const utcNow = "timezone('utc', now())";
