"use server";

import path from "node:path";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/web-backend/auth/session";
import { users } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

export async function removeProfileImage() {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const image = user.image;

	// Delete the profile image from S3 if it exists
	if (image) {
		try {
			// Extract the S3 key - handle both old URL format and new key format
			let s3Key = image;
			if (image.startsWith("http://") || image.startsWith("https://")) {
				const url = new URL(image);
				// Only extract key from URLs with amazonaws.com hostname
				if (
					url.hostname.endsWith(".amazonaws.com") ||
					url.hostname === "amazonaws.com"
				) {
					const raw = url.pathname.startsWith("/")
						? url.pathname.slice(1)
						: url.pathname;
					const decoded = decodeURIComponent(raw);
					const normalized = path.posix.normalize(decoded);
					if (normalized.includes("..")) {
						throw new Error("Invalid S3 key path");
					}
					s3Key = normalized;
				} else {
					// Not an S3 URL, skip deletion of S3 object; continue with DB update below
				}
			}

			// Only delete if it looks like a user profile image key
			if (s3Key.startsWith("users/")) {
				await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
					yield* bucket.deleteObject(s3Key);
				}).pipe(runPromise);
			}
		} catch (error) {
			console.error("Error deleting profile image from S3:", error);
			// Continue with database update even if S3 deletion fails
		}
	}

	await db().update(users).set({ image: null }).where(eq(users.id, user.id));

	revalidatePath("/dashboard/settings/account");

	return { success: true } as const;
}
