import {
	isRateLimited,
	RATE_LIMIT_IDS,
	rateLimitClientAddress,
} from "@/lib/rate-limit";

// Meeting requests are limited per user once signed in, so only requests whose
// sign-in was refused are counted per address. Past that limit an address is
// answered 429 for a while. A desktop key is still looked up, so one client
// on a shared address cannot lock out the others; anything else is answered
// without a lookup.
export const MEETING_AUTH_FAILURE_RETRY_SECONDS = 60;
const BLOCK_MS = MEETING_AUTH_FAILURE_RETRY_SECONDS * 1000;
const MAX_ENTRIES = 10_000;
const DESKTOP_KEY_LENGTH = 36;

const blockedAddresses = new Map<string, number>();

function hasDesktopKey(headers: Headers): boolean {
	const credential = headers.get("authorization")?.trim().split(/\s+/)[1];
	return credential?.length === DESKTOP_KEY_LENGTH;
}

export function meetingAuthBlocked(headers: Headers): boolean {
	if (hasDesktopKey(headers)) return false;
	const address = rateLimitClientAddress(headers);
	if (!address) return false;
	const until = blockedAddresses.get(address);
	if (until === undefined) return false;
	if (until > Date.now()) return true;
	blockedAddresses.delete(address);
	return false;
}

export async function meetingAuthFailureLimited(
	headers: Headers,
): Promise<boolean> {
	const limited = await isRateLimited(RATE_LIMIT_IDS.MEETINGS_AUTH_FAILURE, {
		headers,
	});
	const address = limited ? rateLimitClientAddress(headers) : undefined;
	if (!address) return limited;
	const now = Date.now();
	if (!blockedAddresses.has(address) && blockedAddresses.size >= MAX_ENTRIES) {
		for (const [entry, until] of blockedAddresses) {
			if (until <= now) blockedAddresses.delete(entry);
		}
		if (blockedAddresses.size >= MAX_ENTRIES) blockedAddresses.clear();
	}
	blockedAddresses.set(address, now + BLOCK_MS);
	return limited;
}
