import { Schema } from "effect";

export const optional = <Value extends Schema.Schema<any, any, any>>(
	s: Value,
) => Schema.optional(Schema.OptionFromNullishOr(s, null));
