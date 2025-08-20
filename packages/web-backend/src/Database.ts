import type { db } from "@cap/database";
import { Context, Data, type Effect } from "effect";

export class Database extends Context.Tag("Database")<
	Database,
	{
		execute<T>(
			callback: (_: ReturnType<typeof db>) => Promise<T>,
		): Effect.Effect<T, DatabaseError>;
	}
>() {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
	message: string;
}> {}
