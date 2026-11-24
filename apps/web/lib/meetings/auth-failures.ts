import {
	isRateLimited,
	RATE_LIMIT_IDS,
	rateLimitClientAddress,
} from "@/lib/rate-limit";

// Meeting requests are limited per user once signed in, so only requests whose
// sign-in was not accepted are counted per address. An address over that limit
// is answered without a sign-in lookup on this instance for a while, except
// for a credential this instance accepted recently.
export const MEETING_AUTH_FAILURE_RETRY_SECONDS = 60;
const BLOCK_MS = MEETING_AUTH_FAILURE_RETRY_SECONDS * 1000;
const ACCEPTED_MS = 10 * 60_000;
const MAX_ENTRIES = 10_000;

const blockedAddresses = new Map<string, number>();
const acceptedCredentials = new Map<string, number>();

function remember(map: Map<string, number>, key: string, value: number) {
	if (!map.has(key) && map.size >= MAX_ENTRIES) {
		const now = Date.now();
		for (const [entry, at] of map) {
			if (at <= now) map.delete(entry);
		}
		if (map.size >= MAX_ENTRIES) map.clear();
	}
	map.set(key, value);
}

async function credentialDigest(credential: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(credential),
	);
	return Buffer.from(digest).toString("hex");
}

export function bearerCredential(headers: Headers): string | undefined {
	return headers.get("authorization")?.trim().split(/\s+/)[1] || undefined;
}

export async function meetingAuthBlocked(headers: Headers): Promise<boolean> {
	const address = rateLimitClientAddress(headers);
	if (!address) return false;
	const until = blockedAddresses.get(address);
	if (until === undefined) return false;
	if (until <= Date.now()) {
		blockedAddresses.delete(address);
		return false;
	}
	const credential = bearerCredential(headers);
	if (!credential) return true;
	const acceptedUntil = acceptedCredentials.get(
		await credentialDigest(credential),
	);
	return acceptedUntil === undefined || acceptedUntil <= Date.now();
}

export async function rememberAcceptedCredential(
	headers: Headers,
): Promise<void> {
	const credential = bearerCredential(headers);
	if (!credential) return;
	remember(
		acceptedCredentials,
		await credentialDigest(credential),
		Date.now() + ACCEPTED_MS,
	);
}

export async function meetingAuthFailureLimited(
	headers: Headers,
): Promise<boolean> {
	const limited = await isRateLimited(RATE_LIMIT_IDS.MEETINGS_AUTH_FAILURE, {
		headers,
	});
	const address = limited ? rateLimitClientAddress(headers) : undefined;
	if (address) remember(blockedAddresses, address, Date.now() + BLOCK_MS);
	return limited;
}
