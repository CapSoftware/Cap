import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
	"InternalServerError",
	{ cause: Schema.Literal("database", "s3", "unknown") },
	HttpApiSchema.annotations({ status: 500 }),
) {}
