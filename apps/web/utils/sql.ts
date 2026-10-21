import { type ColumnBaseConfig, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export function jsonExtractString<
	C extends ColumnBaseConfig<"json", "PgJsonb"> & { data: T },
	T extends Record<string, any>,
	F extends keyof T,
>(column: PgColumn<C>, field: F) {
	return sql<string | undefined>`${column} ->> ${field as string}::text`;
}
