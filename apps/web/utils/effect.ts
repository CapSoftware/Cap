import { Option } from "effect";

export const optionFromTOrFirst = (p: string | string[] | undefined) =>
	Option.fromNullable(Array.isArray(p) ? p[0] : p);
