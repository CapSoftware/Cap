"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import {
	type CallToActionErrors,
	type CallToActionInput,
	type ShareCallToAction,
	toStoredCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";

export type UpdateVideoCallToActionResult =
	| { success: true; callToAction: ShareCallToAction | null }
	| { success: false; errors: CallToActionErrors; upgradeRequired?: true };

export async function updateVideoCallToAction(
	videoId: Video.VideoId,
	input: CallToActionInput | null,
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

	if (input === null) {
		await db()
			.update(videos)
			.set({
				settings: sql`JSON_MERGE_PATCH(COALESCE(${videos.settings}, JSON_OBJECT()), CAST('{"callToAction":null}' AS JSON))`,
			})
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
		return { success: true, callToAction: null };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	await db()
		.update(videos)
		.set({
			settings: sql`JSON_MERGE_PATCH(JSON_MERGE_PATCH(COALESCE(${videos.settings}, JSON_OBJECT()), CAST('{"callToAction":null}' AS JSON)), CAST(${JSON.stringify({ callToAction: toStoredCallToAction(result.value) })} AS JSON))`,
		})
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));

	return { success: true, callToAction: result.value };
}
