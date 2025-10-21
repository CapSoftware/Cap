"use server";

import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";

const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024; // 3MB
const ALLOWED_IMAGE_TYPES = new Map<string, string>([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/jpg", "jpg"],
]);

export async function uploadProfileImage(formData: FormData) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const file = formData.get("image") as File | null;

	if (!file) {
		throw new Error("No file provided");
	}

	const normalizedType = file.type.toLowerCase();
	const fileExtension = ALLOWED_IMAGE_TYPES.get(normalizedType);

	if (!fileExtension) {
		throw new Error("Only PNG or JPEG images are supported");
	}

	if (file.size > MAX_FILE_SIZE_BYTES) {
		throw new Error("File size must be 3MB or less");
	}

	// Get the old profile image to delete it later
	const oldImageUrlOrKey = user.image;

	const fileKey = `users/${user.id}/profile-${Date.now()}-${randomUUID()}.${fileExtension}`;

	try {
		const sanitizedFile = await sanitizeFile(file);
		let image: string | null = null;

		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

			// Delete old profile image if it exists
			if (oldImageUrlOrKey) {
				try {
					// Extract the S3 key - handle both old URL format and new key format
					let oldS3Key = oldImageUrlOrKey;
					if (oldImageUrlOrKey.includes("amazonaws.com")) {
						const url = new URL(oldImageUrlOrKey);
						oldS3Key = url.pathname.substring(1); // Remove leading slash
					}

					// Only delete if it looks like a user profile image key
					if (oldS3Key.startsWith("users/")) {
						yield* bucket.deleteObject(oldS3Key);
					}
				} catch (error) {
					console.error("Error deleting old profile image from S3:", error);
					// Continue with upload even if deletion fails
				}
			}

			const bodyBytes = yield* Effect.promise(async () => {
				const buf = await sanitizedFile.arrayBuffer();
				return new Uint8Array(buf);
			});

			yield* bucket.putObject(fileKey, bodyBytes, {
				contentType: file.type,
			});

			image = fileKey;
		}).pipe(runPromise);

		if (!image) {
			throw new Error("Failed to resolve uploaded profile image key");
		}

		const finalImageUrlOrKey = image;

		await db()
			.update(users)
			.set({ image: finalImageUrlOrKey })
			.where(eq(users.id, user.id));

		revalidatePath("/dashboard/settings/account");

		return { success: true, image: finalImageUrlOrKey } as const;
	} catch (error) {
		console.error("Error uploading profile image:", error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
