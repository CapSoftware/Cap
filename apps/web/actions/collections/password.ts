"use server";

import { verifyPassword as verifyPlainPassword } from "@cap/database/crypto";
import { revalidatePath } from "next/cache";
import { TOO_MANY_PASSWORD_ATTEMPTS } from "@/lib/password-attempts";
import { setVerifiedPasswordCookie } from "@/lib/password-cookie";
import { getPublicCollectionPasswordHash } from "@/lib/public-collections";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export async function verifyCollectionPassword(
	collectionId: string,
	password: string,
) {
	try {
		if (!collectionId || typeof password !== "string") {
			return { success: false, error: "Failed to verify password" };
		}

		if (
			(await isRateLimited(RATE_LIMIT_IDS.COLLECTION_PASSWORD)) ||
			(await isRateLimited(RATE_LIMIT_IDS.COLLECTION_PASSWORD_PER_COLLECTION, {
				key: `collection:${collectionId}`,
			}))
		) {
			return { success: false, error: TOO_MANY_PASSWORD_ATTEMPTS };
		}

		// Missing hash and wrong password are expected outcomes (typos, links to
		// collections whose password was since removed) — return without logging
		// so console.error stays reserved for genuine failures.
		const passwordHash = await getPublicCollectionPasswordHash(collectionId);
		const valid = passwordHash
			? await verifyPlainPassword(passwordHash, password)
			: false;
		if (!passwordHash || !valid) {
			return { success: false, error: "Failed to verify password" };
		}

		await setVerifiedPasswordCookie(passwordHash);
		revalidatePath(`/c/${encodeURIComponent(collectionId)}`);

		return { success: true, value: "Password verified" };
	} catch (error) {
		console.error("Error verifying collection password:", error);
		return { success: false, error: "Failed to verify password" };
	}
}
