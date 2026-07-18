"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Folder, Space, Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { getSpaceAccess } from "@/actions/organization/space-authorization";

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
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	if (!videoId) throw new Error("Video ID is required");

	// Get the current video to know its original folder
	const [currentVideo] = await db()
		.select({ folderId: videos.folderId, id: videos.id })
		.from(videos)
		.where(eq(videos.id, videoId));

	const originalFolderId = currentVideo?.folderId;

	const isAllSpacesEntry = spaceId === user.activeOrganizationId;

	// If a destination folder is provided, load it once (scoped to the caller's
	// org) so each branch can also verify the caller may WRITE to that specific
	// folder — not just that the source space/folder is manageable.
	let destinationFolder:
		| { spaceId: string | null; createdById: string }
		| undefined;
	if (folderId) {
		[destinationFolder] = await db()
			.select({
				spaceId: folders.spaceId,
				createdById: folders.createdById,
			})
			.from(folders)
			.where(
				and(
					eq(folders.id, folderId),
					eq(folders.organizationId, user.activeOrganizationId),
				),
			);

		if (!destinationFolder) {
			throw new Error("Folder not found or not accessible");
		}
	}

	if (spaceId && !isAllSpacesEntry) {
		const access = await getSpaceAccess(user.id, spaceId);
		if (!access?.canManage) {
			throw new Error("You don't have permission to manage this space");
		}

		// The destination folder must belong to the same space being managed.
		if (destinationFolder && destinationFolder.spaceId !== spaceId) {
			throw new Error("Folder not found or not accessible");
		}

		await db()
			.update(spaceVideos)
			.set({
				folderId: folderId === null ? null : folderId,
			})
			.where(
				and(eq(spaceVideos.videoId, videoId), eq(spaceVideos.spaceId, spaceId)),
			);
	} else if (spaceId && isAllSpacesEntry) {
		await requireOrganizationSettingsManager(
			user.id,
			user.activeOrganizationId,
		);

		// The destination must be an org-level (non-space) folder.
		if (destinationFolder && destinationFolder.spaceId !== null) {
			throw new Error("Folder not found or not accessible");
		}

		await db()
			.update(sharedVideos)
			.set({
				folderId: folderId === null ? null : folderId,
			})
			.where(
				and(
					eq(sharedVideos.videoId, videoId),
					eq(sharedVideos.organizationId, user.activeOrganizationId),
				),
			);
	} else {
		// Personal move: the destination must be the caller's own personal folder.
		if (
			destinationFolder &&
			(destinationFolder.spaceId !== null ||
				destinationFolder.createdById !== user.id)
		) {
			throw new Error("Folder not found or not accessible");
		}

		await db()
			.update(videos)
			.set({
				folderId: folderId === null ? null : folderId,
			})
			.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)));
	}

	// Always revalidate the main caps page
	revalidatePath(`/dashboard/caps`);

	if (spaceId) {
		revalidatePath(`/dashboard/spaces/${spaceId}/folder/${folderId}`);
	}

	// Revalidate the target folder if it exists
	if (folderId) {
		revalidatePath(`/dashboard/folder/${folderId}`);
	}

	// Revalidate the original folder if it exists
	if (originalFolderId) {
		revalidatePath(`/dashboard/folder/${originalFolderId}`);
	}

	// If we're moving from one folder to another, revalidate the parent folders too
	if (originalFolderId && folderId && originalFolderId !== folderId) {
		// Get parent of original folder
		const [originalFolder] = await db()
			.select({ parentId: folders.parentId })
			.from(folders)
			.where(eq(folders.id, originalFolderId));

		if (originalFolder?.parentId) {
			revalidatePath(`/dashboard/folder/${originalFolder.parentId}`);
		}

		// Get parent of target folder
		const [targetFolder] = await db()
			.select({ parentId: folders.parentId })
			.from(folders)
			.where(eq(folders.id, folderId));

		if (targetFolder?.parentId) {
			revalidatePath(`/dashboard/folder/${targetFolder.parentId}`);
		}
	}
}
