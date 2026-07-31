import "server-only";

import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
} from "node:crypto";
import { serverEnv } from "@cap/env";

const FORMAT_VERSION = "cap-edit-transcript-v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function getEncryptionKey() {
	return createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(FORMAT_VERSION)
		.digest();
}

function getAdditionalData(ownerId: string, videoId: string) {
	return Buffer.from(`${FORMAT_VERSION}:${ownerId}:${videoId}`);
}

export function encryptEditTranscriptObject(
	value: string,
	ownerId: string,
	videoId: string,
) {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
	cipher.setAAD(getAdditionalData(ownerId, videoId));
	const ciphertext = Buffer.concat([
		cipher.update(value, "utf8"),
		cipher.final(),
	]);

	return [
		FORMAT_VERSION,
		iv.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		ciphertext.toString("base64url"),
	].join(".");
}

export function decryptEditTranscriptObject(
	value: string,
	ownerId: string,
	videoId: string,
) {
	const [version, encodedIv, encodedTag, encodedCiphertext, extra] =
		value.split(".");
	if (
		version !== FORMAT_VERSION ||
		!encodedIv ||
		!encodedTag ||
		!encodedCiphertext ||
		extra !== undefined
	) {
		return null;
	}

	try {
		const iv = Buffer.from(encodedIv, "base64url");
		const authTag = Buffer.from(encodedTag, "base64url");
		if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
			return null;
		}

		const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
		decipher.setAAD(getAdditionalData(ownerId, videoId));
		decipher.setAuthTag(authTag);
		return Buffer.concat([
			decipher.update(Buffer.from(encodedCiphertext, "base64url")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return null;
	}
}
