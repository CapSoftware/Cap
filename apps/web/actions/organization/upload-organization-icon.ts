"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { sanitizeFile } from "@/lib/sanitizeFile";
import { runPromise } from "@/lib/server";

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

	// Validate file size (limit to 2MB)
	if (file.size > 2 * 1024 * 1024) {
		throw new Error("File size must be less than 2MB");
	}

	// Create a unique file key
	const fileExtension = file.name.split(".").pop();
	const fileKey = `organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`;

	try {
		const sanitizedFile = await sanitizeFile(file);
		let iconUrl: string | undefined;

		await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

			const bodyBytes = yield* Effect.promise(async () => {
				const buf = await sanitizedFile.arrayBuffer();
				return new Uint8Array(buf);
			});

			yield* bucket.putObject(fileKey, bodyBytes, { contentType: file.type });
			// Construct the icon URL
			if (serverEnv().CAP_AWS_BUCKET_URL) {
				// If a custom bucket URL is defined, use it
				iconUrl = `${serverEnv().CAP_AWS_BUCKET_URL}/${fileKey}`;
			} else if (serverEnv().CAP_AWS_ENDPOINT) {
				// For custom endpoints like MinIO
				iconUrl = `${serverEnv().CAP_AWS_ENDPOINT}/${bucket.bucketName}/${fileKey}`;
			} else {
				// Default AWS S3 URL format
				iconUrl = `https://${bucket.bucketName}.s3.${
					serverEnv().CAP_AWS_REGION || "us-east-1"
				}.amazonaws.com/${fileKey}`;
			}
		}).pipe(runPromise);

		// Update organization with new icon URL
		await db()
			.update(organizations)
			.set({ iconUrl })
			.where(eq(organizations.id, organizationId));

		revalidatePath("/dashboard/settings/organization");

		return { success: true, iconUrl };
	} catch (error) {
		console.error("Error uploading organization icon:", error);
		throw new Error(error instanceof Error ? error.message : "Upload failed");
	}
}
