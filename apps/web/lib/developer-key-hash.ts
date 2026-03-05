import { serverEnv } from "@cap/env";

let hmacKeyCache: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
	if (hmacKeyCache) return hmacKeyCache;
	const secret = serverEnv().NEXTAUTH_SECRET;
	const encoder = new TextEncoder();
	hmacKeyCache = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hmacKeyCache;
}

export async function hashKey(key: string): Promise<string> {
	const hmacKey = await getHmacKey();
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign(
		"HMAC",
		hmacKey,
		encoder.encode(key),
	);
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
