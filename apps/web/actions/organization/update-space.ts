"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoIdLength } from "@cap/database/helpers";
import { spaceMembers, spaces } from "@cap/database/schema";
import { S3Buckets } from "@cap/web-backend";
import { Space, type User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { v4 as uuidv4 } from "uuid";
import { runPromise } from "@/lib/server";
import { uploadSpaceIcon } from "./upload-space-icon";

export async function updateSpace(formData: FormData) {
	const user = await getCurrentUser();
	if (!user) return { success: false, error: "Unauthorized" };

	const id = Space.SpaceId.make(formData.get("id") as string);
	const name = formData.get("name") as string;
	const members = formData.getAll("members[]") as User.UserId[];
	const iconFile = formData.get("icon") as File | null;

	const [membership] = await db()
		.select()
		.from(spaceMembers)
		.where(and(eq(spaceMembers.spaceId, id), eq(spaceMembers.userId, user.id)));

	if (!membership) return { success: false, error: "Unauthorized" };

	// Update space name
	await db().update(spaces).set({ name }).where(eq(spaces.id, id));

	// Update members (simple replace for now)
	await db().delete(spaceMembers).where(eq(spaceMembers.spaceId, id));
	if (members.length > 0) {
		await db()
			.insert(spaceMembers)
			.values(
				members.map((userId) => ({
					id: uuidv4().substring(0, nanoIdLength),
					spaceId: id,
					userId,
				})),
			);
	}

	// Handle icon removal if requested
	if (formData.get("removeIcon") === "true") {
		// Remove icon from S3 and set iconUrl to null
		const spaceArr = await db().select().from(spaces).where(eq(spaces.id, id));
		const space = spaceArr[0];
		if (space?.iconUrl) {
			const key = space.iconUrl.match(/organizations\/.+/)?.[0];

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
	return { success: true };
}
