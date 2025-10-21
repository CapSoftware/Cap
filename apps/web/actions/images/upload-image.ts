"use server";

import { db } from "@cap/database";
import { organizations, users } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { OrganisationId, UserId } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import * as path from "path";
import { runPromise } from "@/lib/server";

export async function uploadImage(
	file: File,
	type: "user" | "organization",
	entityId: string,
	oldImageUrlOrKey?: string | null,
) {
	try {
		const s3Key = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

			// Delete old image if it exists
			if (oldImageUrlOrKey) {
				try {
					// Extract the S3 key - handle both old URL format and new key format
					let oldS3Key = oldImageUrlOrKey;
					if (
						oldImageUrlOrKey.startsWith("http://") ||
						oldImageUrlOrKey.startsWith("https://")
					) {
						const url = new URL(oldImageUrlOrKey);
						const raw = url.pathname.startsWith("/")
							? url.pathname.slice(1)
							: url.pathname;
						const decoded = decodeURIComponent(raw);
						const normalized = path.posix.normalize(decoded);
						if (normalized.includes("..")) {
							throw new Error("Invalid S3 key path");
						}
						oldS3Key = normalized;
					}

					// Only delete if it looks like the correct type of image key
					const expectedPrefix = type === "user" ? "users/" : "organizations/";
					if (oldS3Key.startsWith(expectedPrefix)) {
						yield* bucket.deleteObject(oldS3Key);
					}
				} catch (error) {
					console.error(`Error deleting old %s image from S3:`, type, error);
				}
			}

			// Generate new S3 key
			const timestamp = Date.now();
			const fileExtension = file.name.split(".").pop() || "jpg";
			const s3Key = `${type}s/${entityId}/${timestamp}.${fileExtension}`;

			// Upload new image
			const arrayBuffer = yield* Effect.promise(() => file.arrayBuffer());
			const buffer = Buffer.from(arrayBuffer);
			yield* bucket.putObject(s3Key, buffer, {
				contentType: file.type,
			});

			return s3Key;
		}).pipe(runPromise);

		// Update database
		if (type === "user") {
			await db()
				.update(users)
				.set({ image: s3Key })
				.where(eq(users.id, UserId.make(entityId)));
		} else {
			await db()
				.update(organizations)
				.set({ iconUrl: s3Key })
				.where(eq(organizations.id, OrganisationId.make(entityId)));
		}

		revalidatePath("/dashboard/settings/account");
		if (type === "organization") {
			revalidatePath("/dashboard/settings/organization");
		}

		return { success: true, image: s3Key } as const;
	} catch (error) {
		console.error(`Error uploading %s image:`, type, error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
