import { Schema } from "effect";

export class InternalError extends Schema.TaggedError<InternalError>()(
	"InternalError",
	{ type: Schema.Literals(["database", "s3", "unknown"]) },
) {}
