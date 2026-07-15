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
			return { success: false, error: "密码验证失败" };
		}

		if (await isRateLimited()) {
			return {
				success: false,
				error: "尝试次数过多，请稍后再试。",
			};
		}

		// Missing hash and wrong password are expected outcomes (typos, links to
		// collections whose password was since removed) — return without logging
		// so console.error stays reserved for genuine failures.
		const passwordHash = await getPublicCollectionPasswordHash(collectionId);
		const valid = passwordHash
			? await verifyPlainPassword(passwordHash, password)
			: false;
		if (!passwordHash || !valid) {
			return { success: false, error: "密码验证失败" };
		}

		await setVerifiedPasswordCookie(passwordHash);
		revalidatePath(`/c/${encodeURIComponent(collectionId)}`);

		return { success: true, value: "密码验证成功" };
	} catch (error) {
		console.error("Error verifying collection password:", error);
		return { success: false, error: "密码验证失败" };
	}
}
