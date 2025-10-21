"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

export async function removeOrganizationIcon(
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
		throw new Error("Only the owner can remove the organization icon");
	}

	const iconUrl = organization[0]?.iconUrl;

	// Delete the icon from S3 if it exists
	if (iconUrl) {
		try {
			// Extract the S3 key - handle both old URL format and new key format
			let s3Key = iconUrl;
			if (iconUrl.includes("amazonaws.com")) {
				const url = new URL(iconUrl);
				s3Key = url.pathname.substring(1); // Remove leading slash
			}

			// Only delete if it looks like an organization icon key
			if (s3Key.startsWith("organizations/")) {
				await Effect.gen(function* () {
					const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
					yield* bucket.deleteObject(s3Key);
				}).pipe(runPromise);
			}
		} catch (error) {
			console.error("Error deleting organization icon from S3:", error);
			// Continue with database update even if S3 deletion fails
		}
	}

	// Update organization to remove icon URL
	await db()
		.update(organizations)
		.set({
			iconUrl: null,
		})
		.where(eq(organizations.id, organizationId));

	revalidatePath("/dashboard/settings/organization");

	return { success: true };
}
