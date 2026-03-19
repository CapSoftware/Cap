import { db } from "@cap/database";
import { DatabaseError } from "@cap/web-domain";
import { Effect } from "effect";

export type DbClient = ReturnType<typeof db>;

export class Database extends Effect.Service<Database>()("Database", {
	effect: Effect.gen(function* () {
		return {
			use: <T>(cb: (_: DbClient) => Promise<T>) =>
				Effect.tryPromise({
					try: () => cb(db()),
					catch: (cause) => new DatabaseError({ cause }),
				}),
		};
	}),
}) {}
