import { sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";

export const nanoIdLength = 15;
export const nanoIdLongLength = 30;

export const nanoId = customAlphabet(
	"0123456789abcdefghjkmnpqrstvwxyz",
	nanoIdLength,
);

export const nanoIdLong = customAlphabet(
	"0123456789abcdefghjkmnpqrstvwxyz",
	nanoIdLongLength,
);

export const nanoIdToken = customAlphabet(
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
	32,
);

export type VideoMetadata = {
	resolution: string;
	framerate: string;
};
