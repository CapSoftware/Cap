import { Schema } from "effect";

export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
	"InternalServerError",
	{ cause: Schema.Literals(["database", "s3", "unknown"]) },
	{ httpApiStatus: 500 },
) {}
