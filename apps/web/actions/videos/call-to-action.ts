"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { User, Video } from "@cap/web-domain";
import { type AnyColumn, and, eq, type SQL, sql } from "drizzle-orm";
import {
	type CallToActionErrors,
	type CallToActionInput,
	type CallToActionSource,
	type ShareCallToAction,
	toStoredCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";

export type UpdateVideoCallToActionResult =
	| {
			success: true;
			callToAction: ShareCallToAction | null;
			source: CallToActionSource | null;
	  }
	| { success: false; errors: CallToActionErrors; upgradeRequired?: true };

export type UpdateDefaultCallToActionResult =
	| { success: true; callToAction: ShareCallToAction | null }
	| { success: false; errors: CallToActionErrors; upgradeRequired?: true };

// New users' preferences hold a JSON `null`, which COALESCE keeps and JSON_SET
// can't add a key to, so anything that isn't an object starts empty.
const jsonObject = (column: AnyColumn): SQL =>
	sql`CASE WHEN JSON_TYPE(${column}) = 'OBJECT' THEN ${column} ELSE JSON_OBJECT() END`;

const storeDefaultCallToAction = (
	database: Pick<ReturnType<typeof db>, "update">,
	userId: User.UserId,
	value: ShareCallToAction,
) =>
	database
		.update(users)
		.set({
			preferences: sql`JSON_SET(${jsonObject(users.preferences)}, '$.defaultCallToAction', CAST(${JSON.stringify(toStoredCallToAction(value))} AS JSON))`,
		})
		.where(eq(users.id, userId));

export async function updateVideoCallToAction(
	videoId: Video.VideoId,
	input: CallToActionInput | null,
	options: { asDefault?: boolean } = {},
): Promise<UpdateVideoCallToActionResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!videoId) throw new Error("Missing video");

	const [video] = await db()
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) {
		throw new Error("You don't have permission to update this video");
	}
	if (!userIsPro(user)) {
		return { success: false, errors: {}, upgradeRequired: true };
	}

	const ownedVideo = and(eq(videos.id, videoId), eq(videos.ownerId, user.id));

	if (input === null) {
		await db()
			.update(videos)
			.set({
				settings: sql`JSON_SET(${jsonObject(videos.settings)}, '$.callToAction', CAST('false' AS JSON))`,
			})
			.where(ownedVideo);
		return { success: true, callToAction: null, source: null };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	if (options.asDefault) {
		const value = result.value;
		await db().transaction(async (tx) => {
			await storeDefaultCallToAction(tx, user.id, value);
			await tx
				.update(videos)
				.set({
					settings: sql`JSON_REMOVE(${jsonObject(videos.settings)}, '$.callToAction')`,
				})
				.where(ownedVideo);
		});
		return { success: true, callToAction: value, source: "default" };
	}

	await db()
		.update(videos)
		.set({
			settings: sql`JSON_SET(${jsonObject(videos.settings)}, '$.callToAction', CAST(${JSON.stringify(toStoredCallToAction(result.value))} AS JSON))`,
		})
		.where(ownedVideo);

	return { success: true, callToAction: result.value, source: "video" };
}

export async function updateDefaultCallToAction(
	input: CallToActionInput | null,
): Promise<UpdateDefaultCallToActionResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	if (input === null) {
		await db()
			.update(users)
			.set({
				preferences: sql`JSON_REMOVE(${jsonObject(users.preferences)}, '$.defaultCallToAction')`,
			})
			.where(eq(users.id, user.id));
		return { success: true, callToAction: null };
	}

	if (!userIsPro(user)) {
		return { success: false, errors: {}, upgradeRequired: true };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	await storeDefaultCallToAction(db(), user.id, result.value);
	return { success: true, callToAction: result.value };
}
