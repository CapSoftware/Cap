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
