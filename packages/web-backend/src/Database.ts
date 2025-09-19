import { db } from "@cap/database";
import { Effect, Schema } from "effect";

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	"DatabaseError",
	{ cause: Schema.Unknown },
) {}

export class Database extends Effect.Service<Database>()("Database", {
	effect: Effect.gen(function* () {
		return {
			execute: <T>(cb: (_: ReturnType<typeof db>) => Promise<T>) =>
				Effect.tryPromise({
					try: () => cb(db()),
					catch: (cause) => new DatabaseError({ cause }),
				}),
		};
	}),
}) {}
