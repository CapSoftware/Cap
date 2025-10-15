import { Schema } from "effect";

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
	"DatabaseError",
	{ cause: Schema.Unknown },
) {}
