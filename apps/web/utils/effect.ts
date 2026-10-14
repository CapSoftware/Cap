import { Option } from "effect";

export const optionFromTOrFirst = (p: string | string[] | undefined) =>
	Option.fromNullishOr(Array.isArray(p) ? p[0] : p);
