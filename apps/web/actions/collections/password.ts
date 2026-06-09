"use server";

import { verifyPassword as verifyPlainPassword } from "@cap/database/crypto";
import { NODE_ENV } from "@cap/env";
import { checkRateLimit } from "@vercel/firewall";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { setVerifiedPasswordCookie } from "@/lib/password-cookie";
import { getPublicCollectionPasswordHash } from "@/lib/public-collections";

const COLLECTION_PASSWORD_RATE_LIMIT_ID = "rl_collection_password";

/** Per-IP throttle so the public action isn't an open brute-force oracle. */
async function isRateLimited() {
	if (NODE_ENV !== "production") return false;

	try {
		const headersList = await headers();
		const request = new Request("https://cap.so/api/collection-password", {
			method: "POST",
			headers: headersList,
		});

		const { rateLimited } = await checkRateLimit(
			COLLECTION_PASSWORD_RATE_LIMIT_ID,
			{ request },
		);
		return rateLimited;
	} catch (error) {
		// Best-effort: self-hosted deploys without the Vercel firewall (or an
		// x-real-ip header) must not lose password verification entirely; the
		// PBKDF2 verification cost still slows brute force.
		console.warn("Collection password rate limit check failed:", error);
		return false;
	}
}

export async function verifyCollectionPassword(
	collectionId: string,
	password: string,
) {
	try {
		if (!collectionId || typeof password !== "string") {
			throw new Error("Missing data");
		}

		if (await isRateLimited()) {
			return {
				success: false,
				error: "Too many attempts. Please try again later.",
			};
		}

		const passwordHash = await getPublicCollectionPasswordHash(collectionId);
		if (!passwordHash) throw new Error("No password set");

		const valid = await verifyPlainPassword(passwordHash, password);
		if (!valid) throw new Error("Invalid password");

		await setVerifiedPasswordCookie(passwordHash);
		revalidatePath(`/c/${encodeURIComponent(collectionId)}`);

		return { success: true, value: "Password verified" };
	} catch (error) {
		console.error("Error verifying collection password:", error);
		return { success: false, error: "Failed to verify password" };
	}
}
