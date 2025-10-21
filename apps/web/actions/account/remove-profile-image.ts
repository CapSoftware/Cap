"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
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
			if (image.includes("amazonaws.com")) {
				const url = new URL(image);
				s3Key = url.pathname.substring(1); // Remove leading slash
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
