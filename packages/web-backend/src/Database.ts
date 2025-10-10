import { db } from "@cap/database";
import { DatabaseError } from "@cap/web-domain";
import type { Query } from "drizzle-orm";
import { Effect } from "effect";

export class Database extends Effect.Service<Database>()("Database", {
	effect: Effect.gen(function* () {
		return {
			use: <T>(
				cb: (_: ReturnType<typeof db>) => Promise<T> & { toSQL?(): Query },
			) =>
				Effect.tryPromise({
					try: () => cb(db()),
					catch: (cause) => new DatabaseError({ cause }),
				}),
		};
	}),
}) {}
