import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";

type StorageObjectTokenPayload = {
	videoId: string;
	key: string;
	expiresAt: number;
};

const encode = (value: unknown) =>
	Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const sign = (payload: string) =>
	createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(payload)
		.digest("base64url");

export function createStorageObjectToken(
	payload: Omit<StorageObjectTokenPayload, "expiresAt">,
	ttlSeconds = 3600,
) {
	const encodedPayload = encode({
		...payload,
		expiresAt: Date.now() + ttlSeconds * 1000,
	});
	return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyStorageObjectToken(token: string) {
	const [encodedPayload, signature] = token.split(".");
	if (!encodedPayload || !signature) return null;

	const expected = sign(encodedPayload);
	const signatureBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	if (signatureBuffer.length !== expectedBuffer.length) return null;
	if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

	let payload: StorageObjectTokenPayload;
	try {
		payload = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf8"),
		) as StorageObjectTokenPayload;
	} catch {
		return null;
	}

	if (payload.expiresAt < Date.now()) return null;
	return payload;
}
