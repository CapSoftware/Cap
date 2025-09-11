import { Schema } from "effect";

export class InternalError extends Schema.TaggedError<InternalError>()(
	"InternalError",
	{ type: Schema.Literal("database", "s3", "unknown") },
) {}
