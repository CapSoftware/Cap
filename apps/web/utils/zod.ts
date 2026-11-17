import z from "zod";

// `z.coerce.number().optional()` will turn `null` into `0` which is unintended.
// https://github.com/colinhacks/zod/discussions/2814#discussioncomment-7121766
export const stringOrNumberOptional = z.preprocess((val) => {
	if (val === null || val === undefined) return val;
	if (typeof val === "string") {
		const n = Number(val);
		return Number.isNaN(n) ? val : n; // let z.number() reject non-numeric strings
	}
	return val; // numbers pass through
}, z.number().optional());

// zod 4's .int() also rejects integers beyond Number.MAX_SAFE_INTEGER, which
// zod 3 accepted; this keeps the zod 3 check.
export const integer = () =>
	z.number().refine(Number.isInteger, "Expected integer, received float");
