"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1MB

export async function uploadOrganizationIcon(
	formData: FormData,
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const organization = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, organizationId));

	if (!organization || organization.length === 0) {
		throw new Error("Organization not found");
	}

	if (organization[0]?.ownerId !== user.id) {
		throw new Error("Only the owner can update organization icon");
	}

	const file = formData.get("icon") as File | null;

	if (!file) {
		throw new Error("No file provided");
	}

	// Validate file type
	if (!file.type.startsWith("image/")) {
		throw new Error("File must be an image");
	}

	if (file.size > MAX_FILE_SIZE_BYTES) {
		throw new Error("File size must be less than 1MB");
	}

	// Get the old icon to delete it later
	const oldIconUrlOrKey = organization[0]?.iconUrlOrKey;

	// Create a unique file key
	const fileExtension = file.name.split(".").pop();
	const fileKey = `organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`;

	try {
		const sanitizedFile = await sanitizeFile(file);

		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

			// Delete old icon if it exists
			if (oldIconUrlOrKey) {
				try {
					// Extract the S3 key - handle both old URL format and new key format
					let oldS3Key = oldIconUrlOrKey;
					if (oldIconUrlOrKey.includes("amazonaws.com")) {
						const url = new URL(oldIconUrlOrKey);
						oldS3Key = url.pathname.substring(1); // Remove leading slash
					}

					// Only delete if it looks like an organization icon key
					if (oldS3Key.startsWith("organizations/")) {
						yield* bucket.deleteObject(oldS3Key);
					}
				} catch (error) {
					console.error("Error deleting old organization icon from S3:", error);
					// Continue with upload even if deletion fails
				}
			}

			const bodyBytes = yield* Effect.promise(async () => {
				const buf = await sanitizedFile.arrayBuffer();
				return new Uint8Array(buf);
			});

			yield* bucket.putObject(fileKey, bodyBytes, { contentType: file.type });
		}).pipe(runPromise);

		const iconUrlOrKey = fileKey;

		await db()
			.update(organizations)
			.set({ iconUrlOrKey })
			.where(eq(organizations.id, organizationId));

		revalidatePath("/dashboard/settings/organization");

		return { success: true, iconUrlOrKey };
	} catch (error) {
		console.error("Error uploading organization icon:", error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
