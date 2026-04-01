import { Schema } from "effect";

export const optional = <
	Value extends Schema.Schema<unknown, unknown, unknown>,
>(
	s: Value,
) => Schema.optional(Schema.OptionFromNullishOr(s, null));
