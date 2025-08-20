import z from "zod";

// `z.coerce.number().optional()` will turn `null` into `0` which is unintended.
export const stringOrNumberOptional = z
	.number()
	.or(z.string().nonempty())
	.pipe(z.coerce.number());
