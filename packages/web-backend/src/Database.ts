import { db } from "@cap/database";
import { DatabaseError } from "@cap/web-domain";
import { Context, Effect, Layer } from "effect";

export type DbClient = ReturnType<typeof db>;

const makeDatabase = Effect.gen(function* () {
	return {
		use: <T>(cb: (_: DbClient) => Promise<T>) =>
			Effect.tryPromise({
				try: () => cb(db()),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	};
});

export class Database extends Context.Service<
	Database,
	Effect.Success<typeof makeDatabase>
>()("Database") {
	static readonly Default = Layer.effect(this, makeDatabase);
}
