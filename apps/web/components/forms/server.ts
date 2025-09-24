"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

export async function createOrganization(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	// Extract the name from the FormData
	const name = formData.get("name") as string;
	if (!name) throw new Error("Organization name is required");

	// Check if organization with the same name already exists
	const existingOrg = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.name, name))
		.limit(1);

	if (existingOrg.length > 0) {
		throw new Error("Organization with this name already exists");
	}

	const organizationId = nanoId();

	// Create the organization first
	const orgValues: {
		id: string;
		ownerId: string;
		name: string;
		iconUrl?: string;
	} = {
		id: organizationId,
		ownerId: user.id,
		name: name,
	};

	// Check if an icon file was uploaded
	const iconFile = formData.get("icon") as File;
	if (iconFile) {
		// Validate file type
		if (!iconFile.type.startsWith("image/")) {
			throw new Error("File must be an image");
		}

		// Validate file size (limit to 2MB)
		if (iconFile.size > 2 * 1024 * 1024) {
			throw new Error("File size must be less than 2MB");
		}

		// Create a unique file key
		const fileExtension = iconFile.name.split(".").pop();
		const fileKey = `organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`;

		try {
			let iconUrl: string | undefined;

			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				yield* bucket.putObject(
					fileKey,
					yield* Effect.promise(() => iconFile.bytes()),
					{ contentType: iconFile.type },
				);

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

			// Add the icon URL to the organization values
			orgValues.iconUrl = iconUrl;
		} catch (error) {
			console.error("Error uploading organization icon:", error);
			throw new Error(error instanceof Error ? error.message : "Upload failed");
		}
	}

	// Insert the organization with or without the icon URL
	await db().insert(organizations).values(orgValues);

	// Add the user as an owner of the organization
	await db().insert(organizationMembers).values({
		id: nanoId(),
		userId: user.id,
		role: "owner",
		organizationId,
	});

	// Set this as the active organization for the user
	await db()
		.update(users)
		.set({ activeOrganizationId: organizationId })
		.where(eq(users.id, user.id));

	revalidatePath("/dashboard");
	return { success: true, organizationId };
}
