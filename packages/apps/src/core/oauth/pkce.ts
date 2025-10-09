import { createHash, randomBytes } from "node:crypto";

const toBase64Url = (buffer: Buffer) =>
	buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

export const generateCodeVerifier = (length = 32) =>
	toBase64Url(randomBytes(length));

export const generateCodeChallenge = (verifier: string) =>
	toBase64Url(createHash("sha256").update(verifier).digest());

export const generatePkcePair = (length?: number) => {
	const codeVerifier = generateCodeVerifier(length);
	return {
		codeVerifier,
		codeChallenge: generateCodeChallenge(codeVerifier),
	} as const;
};
