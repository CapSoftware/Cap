import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import pg from "pg";

// node-postgres returns int8 (COUNT, bigint) and numeric (SUM, AVG) as strings.
// Cap's queries were written against mysql2, which returns JS numbers for these.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
// `timestamp` columns are timezone-less UTC; serialize raw Date parameters as UTC
// instead of the process-local offset so they match what Drizzle writes.
pg.defaults.parseInputDatesAsUTC = true;

export const isPostgresUrl = (url: string) =>
	url.startsWith("postgres://") || url.startsWith("postgresql://");

export function createPool(connectionString: string, config?: pg.PoolConfig) {
	const pool = new pg.Pool({ connectionString, ...config });
	pool.on("error", (error) => {
		console.error("Unexpected Postgres pool error", error);
	});
	return pool;
}

function createDrizzle() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not found");

	if (!isPostgresUrl(url))
		throw new Error("DATABASE_URL is not a PostgreSQL URL");

	return drizzle({ client: createPool(url) });
}

let _cached: ReturnType<typeof createDrizzle> | undefined;

export const db = () => {
	if (!_cached) {
		_cached = createDrizzle();

		instrumentDrizzleClient(_cached, { dbSystem: "postgresql" });
	}
	return _cached;
};

// Use the incoming value if one exists, else fallback to the DBs existing value.
export const updateIfDefined = <T>(v: T | undefined, col: AnyPgColumn) =>
	sql`COALESCE(${v === undefined ? sql`NULL` : v}, ${col})`;
