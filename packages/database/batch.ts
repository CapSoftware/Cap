import { inArray, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

// Postgres has no `DELETE ... LIMIT`, so bound the batch with a keyed subquery.
export const deleteBatch = (
	database: Pick<NodePgDatabase, "delete" | "select">,
	table: PgTable,
	key: AnyPgColumn,
	where: SQL | undefined,
	limit: number,
) =>
	database
		.delete(table)
		.where(
			inArray(
				key,
				database.select({ key }).from(table).where(where).limit(limit),
			),
		);
