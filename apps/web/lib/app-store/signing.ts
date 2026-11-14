import "server-only";

import { type CapSigningKey, deriveSigningKey } from "@cap/app-store/signing";
import { serverEnv } from "@cap/env";

let cached: { secret: string; key: CapSigningKey } | null = null;

export function appStoreSigningKey(): CapSigningKey {
	const secret = serverEnv().NEXTAUTH_SECRET;
	if (!cached || cached.secret !== secret) {
		cached = { secret, key: deriveSigningKey(secret) };
	}
	return cached.key;
}

export function appStorePublicKeys() {
	return { keys: [appStoreSigningKey().publicKey] };
}
