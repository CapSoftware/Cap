"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import type { VideoEditSpec } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import {
	restoreVideoToOriginalAsUser,
	saveVideoEditsAsUser,
} from "@/lib/video-edit-save";

export async function saveVideoEdits(
	videoId: Video.VideoId,
	editSpec: VideoEditSpec,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	return saveVideoEditsAsUser(user, videoId, editSpec);
}

export async function restoreVideoToOriginal(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	return restoreVideoToOriginalAsUser(user, videoId);
}
