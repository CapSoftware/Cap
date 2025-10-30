"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { spaceMembers, spaces } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import {
	Space,
	SpaceMemberId,
	type SpaceMemberRole,
	type User,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { uploadSpaceIcon } from "./upload-space-icon";

export async function updateSpace(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	const id = Space.SpaceId.make(formData.get("id") as string);
	const name = formData.get("name") as string;
	const members = formData.getAll("members[]") as User.UserId[];
	const iconFile = formData.get("icon") as File | null;

	// Get the space to check authorization
	const [space] = await db()
		.select({
			createdById: spaces.createdById,
			organizationId: spaces.organizationId,
		})
		.from(spaces)
		.where(eq(spaces.id, id))
		.limit(1);

	if (!space) {
		return { success: false, error: "Space not found" };
	}

	// Check if user is the creator or a member of the space
	const isCreator = space.createdById === user.id;
	const [membership] = await db()
		.select()
		.from(spaceMembers)
		.where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, user.id)))
		.limit(1);

	if (!isCreator && !membership) {
		return { success: false, error: "Unauthorized" };
	}

	// Update space name
	await db().update(spaces).set({ name }).where(eq(spaces.id, id));

	// Update members - ensure creator is always included
	const memberIds = Array.from(new Set([...members, space.createdById]));

	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, id));
	await db()
		.insert(spaceMembers)
		.values(
			memberIds.map((userId) => {
				const role: SpaceMemberRole =
					userId === space.createdById ? "Admin" : "member";
				return {
					id: SpaceMemberId.make(nanoId()),
					spaceId: id,
					userId,
					role,
				};
			}),
		);

	// Handle icon removal if requested
	if (formData.get("removeIcon") === "true") {
		// Remove icon from S3 and set iconUrl to null
		const spaceArr = await db().select().from(spaces).where(eq(spaces.id, id));
		const spaceData = spaceArr[0];
		if (spaceData?.iconUrl) {
			// Extract the S3 key (it might already be a key or could be a legacy URL)
			const key = spaceData.iconUrl.startsWith("organizations/")
				? spaceData.iconUrl
				: spaceData.iconUrl.match(/organizations\/.+/)?.[0];

			if (key) {
				try {
					await Effect.gen(function* () {
						const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
						yield* bucket.deleteObject(key);
					}).pipe(runPromise);
				} catch (e) {
					console.warn("Failed to delete old space icon from S3", e);
				}
			}
		}
		await db().update(spaces).set({ iconUrl: null }).where(eq(spaces.id, id));
	} else if (iconFile && iconFile.size > 0) {
		await uploadSpaceIcon(formData, id);
	}

	revalidatePath("/dashboard");
	revalidatePath(`/dashboard/spaces/${id}`);
	return { success: true };
}
