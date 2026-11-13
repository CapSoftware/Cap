import { createHash, randomBytes } from "node:crypto";

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
