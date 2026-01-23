"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { nanoId } from "@inflight/database/helpers";
import {
	organizationMembers,
	organizations,
	users,
} from "@inflight/database/schema";
import { S3Buckets } from "@inflight/web-backend";
import { ImageUpload, Organisation, type User } from "@inflight/web-domain";
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

	const organizationId = Organisation.OrganisationId.make(nanoId());

	// Create the organization first
	const orgValues: {
		id: Organisation.OrganisationId;
		ownerId: User.UserId;
		name: string;
		iconUrl?: ImageUpload.ImageUrlOrKey;
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
		const fileKey = ImageUpload.ImageKey.make(
			`organizations/${organizationId}/icon-${Date.now()}.${fileExtension}`,
		);

		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				yield* bucket.putObject(
					fileKey,
					yield* Effect.promise(() => iconFile.arrayBuffer()),
					{ contentType: iconFile.type },
				);
			}).pipe(runPromise);

			orgValues.iconUrl = fileKey;
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
