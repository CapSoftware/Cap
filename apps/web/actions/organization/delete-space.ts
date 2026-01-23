"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import {
	folders,
	spaceMembers,
	spaces,
	spaceVideos,
} from "@inflight/database/schema";
import { S3Buckets } from "@inflight/web-backend";
import type { Space } from "@inflight/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";

interface DeleteSpaceResponse {
	success: boolean;
	error?: string;
}

export async function deleteSpace(
	spaceId: Space.SpaceIdOrOrganisationId,
): Promise<DeleteSpaceResponse> {
	try {
		const user = await getCurrentUser();

		if (!user || !user.activeOrganizationId) {
			return {
				success: false,
				error: "User not logged in or no active organization",
			};
		}

		// Check if the space exists and belongs to the user's organization
		const space = await db()
			.select()
			.from(spaces)
			.where(eq(spaces.id, spaceId))
			.limit(1);

		if (!space || space.length === 0) {
			return {
				success: false,
				error: "Space not found",
			};
		}

		// Check if user has permission to delete the space
		// Only the space creator or organization owner should be able to delete spaces
		const spaceData = space[0];
		if (!spaceData || spaceData.createdById !== user.id) {
			return {
				success: false,
				error: "You don't have permission to delete this space",
			};
		}

		// Delete in order to maintain referential integrity:

		// 1. First delete all space videos
		await db().delete(spaceVideos).where(eq(spaceVideos.spaceId, spaceId));

		// 2. Delete all space members
		await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));

		// 3. Delete all space folders
		await db().delete(folders).where(eq(folders.spaceId, spaceId));

		// 4. Delete space icons from S3
		try {
			await Effect.gen(function* () {
				const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());

				const listedObjects = yield* bucket.listObjects({
					prefix: `organizations/${user.activeOrganizationId}/spaces/${spaceId}/`,
				});

				if (listedObjects.Contents) {
					yield* bucket.deleteObjects(
						listedObjects.Contents.map((content) => ({
							Key: content.Key,
						})),
					);

					console.log(
						`Deleted ${listedObjects.Contents.length} objects for space ${spaceId}`,
					);
				}
			}).pipe(runPromise);

			// List all objects with the space prefix
		} catch (error) {
			console.error("Error deleting space icons from S3:", error);
			// Continue with space deletion even if S3 deletion fails
		}

		await db().delete(spaces).where(eq(spaces.id, spaceId));

		revalidatePath("/dashboard");

		return {
			success: true,
		};
	} catch (error) {
		console.error("Error deleting space:", error);
		return {
			success: false,
			error: "Failed to delete space",
		};
	}
}
