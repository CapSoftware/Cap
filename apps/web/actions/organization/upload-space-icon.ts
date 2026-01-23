"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { spaces } from "@inflight/database/schema";
import { S3Buckets } from "@inflight/web-backend";
import { ImageUpload, type Space } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";

export async function uploadSpaceIcon(
	formData: FormData,
	spaceId: Space.SpaceId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	// Fetch the space and check permissions
	const spaceArr = await db()
		.select()
		.from(spaces)
		.where(eq(spaces.id, spaceId));

	if (!spaceArr || spaceArr.length === 0) {
		throw new Error("Space not found");
	}
	const space = spaceArr[0];

	if (!space) {
		throw new Error("Space not found");
	}

	if (space.organizationId !== user.activeOrganizationId) {
		throw new Error("You do not have permission to update this space");
	}

	const file = formData.get("icon") as File;
	if (!file) {
		throw new Error("No file provided");
	}
	if (!file.type.startsWith("image/")) {
		throw new Error("File must be an image");
	}
	if (file.size > 1024 * 1024) {
		throw new Error("File size must be less than 1MB");
	}

	// Prepare new file key
	const fileExtension = file.name.split(".").pop();
	const fileKey = ImageUpload.ImageKey.make(
		`organizations/${
			space.organizationId
		}/spaces/${spaceId}/icon-${Date.now()}.${fileExtension}`,
	);

	const [bucket] = await S3Buckets.getBucketAccess(Option.none()).pipe(
		runPromise,
	);

	try {
		// Remove previous icon if exists
		if (space.iconUrl) {
			// Extract the S3 key (it might already be a key or could be a legacy URL)
			const key = space.iconUrl.startsWith("organizations/")
				? space.iconUrl
				: space.iconUrl.match(/organizations\/.+/)?.[0];
			if (key) {
				try {
					await bucket.deleteObject(key).pipe(runPromise);
				} catch (e) {
					// Log and continue
					console.warn("Failed to delete old space icon from S3", e);
				}
			}
		}

		const sanitizedFile = await sanitizeFile(file);
		const arrayBuffer = await sanitizedFile.arrayBuffer();

		await bucket
			.putObject(fileKey, new Uint8Array(arrayBuffer), {
				contentType: file.type,
			})
			.pipe(runPromise);

		await db()
			.update(spaces)
			.set({ iconUrl: fileKey })
			.where(eq(spaces.id, spaceId));

		revalidatePath("/dashboard");
		return { success: true, iconUrl: fileKey };
	} catch (error) {
		console.error("Error uploading space icon:", error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
