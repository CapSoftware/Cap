import { db } from "@cap/database";
import { DatabaseError } from "@cap/web-domain";
import type { Query } from "drizzle-orm";
import { Effect } from "effect";

export class Database extends Effect.Service<Database>()("Database", {
	effect: Effect.gen(function* () {
		return {
			use: <T>(
				cb: (_: ReturnType<typeof db>) => Promise<T> & { toSQL?(): Query },
			) => {
				const promise = cb(db());
				const sql = promise.toSQL?.().sql ?? "Transaction";

				return Effect.tryPromise({
					try: () => promise,
					catch: (cause) => new DatabaseError({ cause }),
				}).pipe(Effect.withSpan("Database.execute", { attributes: { sql } }));
			},
		};
	}),
}) {}
