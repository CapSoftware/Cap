import { createHash, randomBytes } from "node:crypto";
import { apiErrorBody } from "@/lib/api-errors";

const DEVELOPER_ID_LENGTH = 15;

export function developerIdFromKey(kind: string, appId: string, key: string) {
	for (let attempt = 0; ; attempt += 1) {
		const parts =
			attempt === 0 ? [kind, appId, key] : [kind, appId, key, String(attempt)];
		const id = createHash("sha256")
			.update(parts.join("\0"), "utf8")
			.digest("base64url")
			.slice(0, DEVELOPER_ID_LENGTH);
		if (!id.startsWith("-")) return id;
	}
}

export function randomDeveloperId(
	byteLength: number,
	source: (size: number) => Buffer = randomBytes,
) {
	for (;;) {
		const id = source(byteLength).toString("base64url");
		if (!id.startsWith("-")) return id;
	}
}

export function isDeveloperIdempotencyKey(value: string | undefined | null) {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 128 &&
		/^[A-Za-z0-9._-]+$/.test(value)
	);
}

export const invalidIdempotencyKey = () =>
	apiErrorBody(
		"invalid_idempotency_key",
		"Idempotency-Key is not valid",
		"Send 8 to 128 characters from letters, digits, dot, dash and underscore.",
	);

export function readIdempotencyKey(header: string | undefined) {
	if (header === undefined) return { ok: true as const, key: undefined };
	return isDeveloperIdempotencyKey(header)
		? { ok: true as const, key: header }
		: { ok: false as const };
}

// The alphabet and length of nanoId() in @cap/database/helpers, so a video
// created with an Idempotency-Key has an id of the same kind as any other.
const VIDEO_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const VIDEO_ID_LENGTH = 15;

export function developerVideoIdForIdempotencyKey(appId: string, key: string) {
	const digest = createHash("sha256")
		.update(["developer-video", appId, key].join("\0"), "utf8")
		.digest();
	let id = "";
	for (let index = 0; index < VIDEO_ID_LENGTH; index += 1) {
		const bit = index * 5;
		const pair = (digest[bit >> 3] ?? 0) * 256 + (digest[(bit >> 3) + 1] ?? 0);
		id += VIDEO_ID_ALPHABET[(pair >> (11 - (bit & 7))) & 31];
	}
	return id;
}

// Videos created with an Idempotency-Key before ids matched the alphabet above
// keep the id they were given, so a repeat of such a key still finds them.
export function legacyDeveloperVideoIdForIdempotencyKey(
	appId: string,
	key: string,
) {
	return developerIdFromKey("developer-video", appId, key);
}
