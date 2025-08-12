import { type ColumnBaseConfig, sql } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";

export function jsonExtractString<
	C extends ColumnBaseConfig<"json", "MySqlJson"> & { data: T },
	T extends Record<string, any>,
	F extends keyof T,
>(column: MySqlColumn<C>, field: F) {
	const jsonParam = `$.${field as string}`;
	return sql<
		string | undefined
	>`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonParam}))`;
}
