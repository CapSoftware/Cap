import { Context, Data, Effect } from "effect";
import { db } from "@cap/database";

export class Database extends Context.Tag("Database")<
  Database,
  {
    execute<T>(
      callback: (_: ReturnType<typeof db>) => Promise<T>
    ): Effect.Effect<T, DatabaseError>;
  }
>() {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  message: string;
}> {}
