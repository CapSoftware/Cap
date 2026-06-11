import "server-only";

import { decrypt, encrypt } from "@cap/database/crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "x-cap-password";

// A verified hash is ~64 base64 chars, so 10 entries encrypt to well under
// the 4KB cookie limit while covering any realistic number of concurrently
// open password-protected shares.
const MAX_VERIFIED_HASHES = 10;

/**
 * Every share password (video or collection) this browser has verified. The
 * cookie holds an encrypted JSON array of password hashes so unlocking one
 * resource never evicts another; pre-array cookies that hold a single bare
 * hash are still accepted.
 */
export async function getVerifiedPasswordHashes(): Promise<string[]> {
	const cookieValue = (await cookies()).get(COOKIE_NAME)?.value;
	if (!cookieValue) return [];

	let decrypted: string;
	try {
		// decrypt is async — without the await its rejection (corrupt or stale
		// cookie, rotated encryption key) would escape this catch and crash the
		// page instead of falling back to the password prompt.
		decrypted = await decrypt(cookieValue);
	} catch {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(decrypted);
		if (
			Array.isArray(parsed) &&
			parsed.every((hash) => typeof hash === "string")
		) {
			return parsed;
		}
	} catch {
		// Legacy cookie: the decrypted value is the hash itself.
	}
	return [decrypted];
}

/**
 * Marks a share password (video or collection) as verified for this browser
 * session. The cookie is shared by the `/s/` and `/c/` flows and is never
 * read client-side — so it can be locked down.
 */
export async function setVerifiedPasswordCookie(passwordHash: string) {
	const hashes = (await getVerifiedPasswordHashes()).filter(
		(hash) => hash !== passwordHash,
	);
	hashes.push(passwordHash);

	(await cookies()).set(
		COOKIE_NAME,
		await encrypt(JSON.stringify(hashes.slice(-MAX_VERIFIED_HASHES))),
		{
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			path: "/",
		},
	);
}
