"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import {
	parseRecorderCamera,
	type RecorderCameraLayout,
} from "@cap/editor-cap-bundle/default-style";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";

/**
 * Keeps where the camera sat in the browser recorder, so the editor and the
 * first render open with the same layout. Only the owner can set it.
 */
export async function setRecorderCamera({
	videoId,
	layout,
}: {
	videoId: Video.VideoId;
	layout: RecorderCameraLayout;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const recorderCamera = parseRecorderCamera(layout);
	if (!recorderCamera) throw new Error("Invalid camera layout");

	const patch = JSON.stringify({ recorderCamera });
	const [result] = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_MERGE_PATCH(COALESCE(${videos.metadata}, JSON_OBJECT()), ${patch})`,
		})
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
	return { success: result.affectedRows > 0 };
}
