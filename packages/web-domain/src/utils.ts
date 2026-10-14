import { Schema } from "effect";

export const optional = <Value extends Schema.Top>(s: Value) =>
	Schema.optional(Schema.OptionFromNullishOr(s, { onNoneEncoding: null }));
