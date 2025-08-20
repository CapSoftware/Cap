import { serverEnv } from "@cap/env";
import { Client, type Config } from "@planetscale/database";
import { sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/planetscale-serverless";

function createDrizzle() {
	const URL = serverEnv().DATABASE_URL;

	let fetchHandler: Promise<Config["fetch"]> | undefined;

	if (URL.startsWith("mysql://")) {
		fetchHandler = import("@mattrax/mysql-planetscale").then((m) =>
			m.createFetchHandler(URL),
		);
	}

	const connection = new Client({
		url: URL,
		fetch: async (input, init) => {
			return await ((await fetchHandler) || fetch)(input, init);
		},
	});

	return drizzle(connection);
}

let _cached: ReturnType<typeof createDrizzle> | undefined;

export const db = () => {
	if (!_cached) {
		_cached = createDrizzle();
	}
	return _cached;
};

// Use the incoming value if one exists, else fallback to the DBs existing value.
export const updateIfDefined = <T>(v: T | undefined, col: AnyMySqlColumn) =>
	sql`COALESCE(${v ?? sql`NULL`}, ${col})`;
