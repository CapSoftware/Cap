"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import type { Folder, Space, Video } from "@cap/web-domain";
import { moveVideos } from "@/actions/folders/move-items";
import { resolveMoveLocation } from "@/lib/move-items";

export async function moveVideoToFolder({
	videoId,
	folderId,
	spaceId,
}: {
	videoId: Video.VideoId;
	folderId: Folder.FolderId | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	return moveVideos({
		videoIds: [videoId],
		folderId,
		location: resolveMoveLocation(spaceId, user.activeOrganizationId),
	});
}
