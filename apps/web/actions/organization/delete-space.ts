"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	spaceMembers,
	spaces,
	spaceVideos,
} from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import type { Space } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { requireSpaceManager } from "./space-authorization";

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

		const spaceData = space[0];
		const access = await requireSpaceManager(user.id, spaceId).catch(
			() => null,
		);
		if (!spaceData || !access) {
			return {
				success: false,
				error: "You don't have permission to delete this space",
			};
		}

		await db().delete(spaceVideos).where(eq(spaceVideos.spaceId, spaceId));

		await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));

		await db().delete(folders).where(eq(folders.spaceId, spaceId));

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
		} catch (error) {
			console.error("Error deleting space icons from S3:", error);
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
