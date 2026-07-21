"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	folders,
	sharedVideos,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Folder, Video } from "@cap/web-domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import { requireSpaceManager } from "@/actions/organization/space-authorization";
import {
	MAX_MOVE_ITEMS,
	type MoveFolderDestination,
	type MoveLocation,
} from "@/lib/move-items";

function requireValidLocation(location: MoveLocation) {
	if (
		!location ||
		(location.type !== "personal" &&
			location.type !== "organization" &&
			location.type !== "space")
	) {
		throw new Error("Invalid move location");
	}

	if (location.type === "space" && !location.spaceId) {
		throw new Error("A space is required");
	}
}

async function requireMoveAccess(
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	location: MoveLocation,
) {
	requireValidLocation(location);

	if (location.type === "personal") return;

	if (location.type === "organization") {
		await requireOrganizationSettingsManager(
			user.id,
			user.activeOrganizationId,
		);
		return;
	}

	const access = await requireSpaceManager(user.id, location.spaceId);
	if (access.organizationId !== user.activeOrganizationId) {
		throw new Error("Space not found");
	}
}

function getFolderScope(
	user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
	location: MoveLocation,
) {
	if (location.type === "personal") {
		return and(
			eq(folders.organizationId, user.activeOrganizationId),
			eq(folders.createdById, user.id),
			isNull(folders.spaceId),
		);
	}

	return and(
		eq(folders.organizationId, user.activeOrganizationId),
		eq(
			folders.spaceId,
			location.type === "organization"
				? user.activeOrganizationId
				: location.spaceId,
		),
	);
}

function normalizeVideoIds(videoIds: Video.VideoId[]) {
	const ids = [...new Set(videoIds)];
	if (ids.length === 0) throw new Error("Select at least one Cap to move");
	if (ids.length > MAX_MOVE_ITEMS) {
		throw new Error(`You can move up to ${MAX_MOVE_ITEMS} Caps at once`);
	}
	return ids;
}

function revalidateMoveLocation(location: MoveLocation) {
	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder/[id]", "page");

	if (location.type !== "personal") {
		revalidatePath("/dashboard/spaces/[spaceId]", "page");
		revalidatePath("/dashboard/spaces/[spaceId]/folder/[folderId]", "page");
	}
}

export async function getMoveFolderDestinations(
	location: MoveLocation,
): Promise<MoveFolderDestination[]> {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	await requireMoveAccess(user, location);

	return db()
		.select({ id: folders.id, name: folders.name, parentId: folders.parentId })
		.from(folders)
		.where(getFolderScope(user, location))
		.orderBy(asc(folders.name));
}

export async function moveVideos({
	videoIds,
	folderId,
	location,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	location: MoveLocation;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	const ids = normalizeVideoIds(videoIds);
	await requireMoveAccess(user, location);

	await db().transaction(async (tx) => {
		if (folderId) {
			const [targetFolder] = await tx
				.select({ id: folders.id })
				.from(folders)
				.where(and(eq(folders.id, folderId), getFolderScope(user, location)))
				.limit(1);

			if (!targetFolder) throw new Error("Destination folder not found");
		}

		if (location.type === "personal") {
			const movableVideos = await tx
				.select({ id: videos.id })
				.from(videos)
				.where(
					and(
						inArray(videos.id, ids),
						eq(videos.ownerId, user.id),
						eq(videos.orgId, user.activeOrganizationId),
					),
				);

			if (new Set(movableVideos.map((video) => video.id)).size !== ids.length) {
				throw new Error("One or more Caps cannot be moved");
			}

			await tx
				.update(videos)
				.set({ folderId })
				.where(
					and(
						inArray(videos.id, ids),
						eq(videos.ownerId, user.id),
						eq(videos.orgId, user.activeOrganizationId),
					),
				);
			return;
		}

		if (location.type === "organization") {
			const movableVideos = await tx
				.selectDistinct({ id: sharedVideos.videoId })
				.from(sharedVideos)
				.where(
					and(
						inArray(sharedVideos.videoId, ids),
						eq(sharedVideos.organizationId, user.activeOrganizationId),
					),
				);

			if (movableVideos.length !== ids.length) {
				throw new Error("One or more Caps cannot be moved");
			}

			await tx
				.update(sharedVideos)
				.set({ folderId })
				.where(
					and(
						inArray(sharedVideos.videoId, ids),
						eq(sharedVideos.organizationId, user.activeOrganizationId),
					),
				);
			return;
		}

		const movableVideos = await tx
			.selectDistinct({ id: spaceVideos.videoId })
			.from(spaceVideos)
			.where(
				and(
					inArray(spaceVideos.videoId, ids),
					eq(spaceVideos.spaceId, location.spaceId),
				),
			);

		if (movableVideos.length !== ids.length) {
			throw new Error("One or more Caps cannot be moved");
		}

		await tx
			.update(spaceVideos)
			.set({ folderId })
			.where(
				and(
					inArray(spaceVideos.videoId, ids),
					eq(spaceVideos.spaceId, location.spaceId),
				),
			);
	});

	revalidateMoveLocation(location);
	return { moved: ids.length };
}

export async function moveFolder({
	folderId,
	parentId,
	location,
}: {
	folderId: Folder.FolderId;
	parentId: Folder.FolderId | null;
	location: MoveLocation;
}) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");

	await requireMoveAccess(user, location);

	await db().transaction(async (tx) => {
		const scopedFolders = await tx
			.select({ id: folders.id, parentId: folders.parentId })
			.from(folders)
			.where(getFolderScope(user, location));
		const foldersById = new Map(
			scopedFolders.map((folder) => [folder.id, folder]),
		);

		if (!foldersById.has(folderId)) throw new Error("Folder not found");
		if (parentId && !foldersById.has(parentId)) {
			throw new Error("Destination folder not found");
		}

		const visited = new Set<Folder.FolderId>();
		let currentParentId = parentId;
		while (currentParentId) {
			if (currentParentId === folderId) {
				throw new Error("A folder cannot be moved into itself");
			}
			if (visited.has(currentParentId)) {
				throw new Error("Invalid folder hierarchy");
			}
			visited.add(currentParentId);
			currentParentId = foldersById.get(currentParentId)?.parentId ?? null;
		}

		await tx
			.update(folders)
			.set({ parentId })
			.where(and(eq(folders.id, folderId), getFolderScope(user, location)));
	});

	revalidateMoveLocation(location);
}
