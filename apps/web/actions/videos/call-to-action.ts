"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import {
	type CallToActionErrors,
	type CallToActionInput,
	type ShareCallToAction,
	toStoredCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";

export type UpdateVideoCallToActionResult =
	| { success: true; callToAction: ShareCallToAction | null }
	| { success: false; errors: CallToActionErrors };

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

	if (input === null) {
		await db()
			.update(videos)
			.set({
				settings: sql`JSON_REMOVE(COALESCE(${videos.settings}, JSON_OBJECT()), '$.callToAction')`,
			})
			.where(eq(videos.id, videoId));
		return { success: true, callToAction: null };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	await db()
		.update(videos)
		.set({
			settings: sql`JSON_SET(COALESCE(${videos.settings}, JSON_OBJECT()), '$.callToAction', CAST(${JSON.stringify(toStoredCallToAction(result.value))} AS JSON))`,
		})
		.where(eq(videos.id, videoId));

	return { success: true, callToAction: result.value };
}
