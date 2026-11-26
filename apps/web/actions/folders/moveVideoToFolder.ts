"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import type { Folder, Space, Video } from "@cap/web-domain";
import { moveFolder, moveVideos } from "@/actions/folders/move-items";
import { resolveMoveLocation } from "@/lib/move-items";

export async function moveVideosToFolder({
	videoIds,
	folderId,
	spaceId,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	return moveVideos({
		videoIds,
		folderId,
		location: resolveMoveLocation(spaceId, user.activeOrganizationId),
	});
}

export async function moveVideoToFolder({
	videoId,
	folderId,
	spaceId,
}: {
	videoId: Video.VideoId;
	folderId: Folder.FolderId | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
}) {
	return moveVideosToFolder({ videoIds: [videoId], folderId, spaceId });
}

export async function moveFolderToFolder({
	folderId,
	parentId,
	spaceId,
}: {
	folderId: Folder.FolderId;
	parentId: Folder.FolderId | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	return moveFolder({
		folderId,
		parentId,
		location: resolveMoveLocation(spaceId, user.activeOrganizationId),
	});
}
