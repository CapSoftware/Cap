"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	sharedVideos,
	spaceMembers,
	spaces,
	spaceVideos,
	videos,
} from "@cap/database/schema";
import type { Folder, Organisation, Video } from "@cap/web-domain";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	requireOrganizationAccess,
	requireOrganizationSettingsManager,
} from "@/actions/organization/authorization";
import {
	getSpaceAccess,
	requireSpaceManager,
} from "@/actions/organization/space-authorization";
import {
	MAX_MOVE_ITEMS,
	type MoveDestinationGroup,
	type MoveFolderDestination,
	type MoveLocation,
} from "@/lib/move-items";
import {
	canManageOrganizationSettings,
	getEffectiveSpaceRole,
} from "@/lib/permissions/roles";

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
	organizationId: Organisation.OrganisationId = user.activeOrganizationId,
) {
	if (location.type === "personal") {
		return and(
			eq(folders.organizationId, organizationId),
			eq(folders.createdById, user.id),
			isNull(folders.spaceId),
		);
	}

	return and(
		eq(folders.organizationId, organizationId),
		eq(
			folders.spaceId,
			location.type === "organization" ? organizationId : location.spaceId,
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

export async function getOwnedVideoMoveDestinations(
	requestedOrganizationId?: Organisation.OrganisationId,
): Promise<MoveDestinationGroup[]> {
	const user = await getCurrentUser();
	const organizationId = requestedOrganizationId ?? user?.activeOrganizationId;
	if (!user || !organizationId) throw new Error("Unauthorized");
	const access = await requireOrganizationAccess(user.id, organizationId);
	const availableSpaces = await db()
		.select({ id: spaces.id, name: spaces.name })
		.from(spaces)
		.leftJoin(
			spaceMembers,
			and(
				eq(spaceMembers.spaceId, spaces.id),
				eq(spaceMembers.userId, user.id),
			),
		)
		.where(
			and(
				eq(spaces.organizationId, organizationId),
				canManageOrganizationSettings(access.role)
					? undefined
					: or(
							eq(spaces.createdById, user.id),
							eq(spaceMembers.userId, user.id),
						),
			),
		)
		.orderBy(asc(spaces.name));
	const organizationFolders = await db()
		.select({
			id: folders.id,
			name: folders.name,
			parentId: folders.parentId,
			spaceId: folders.spaceId,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, organizationId),
				or(
					and(eq(folders.createdById, user.id), isNull(folders.spaceId)),
					inArray(folders.spaceId, [
						organizationId,
						...availableSpaces.map((space) => space.id),
					]),
				),
			),
		)
		.orderBy(asc(folders.name));
	return [
		{
			location: { type: "personal" },
			name: "My Caps",
			folders: organizationFolders.filter((folder) => folder.spaceId === null),
		},
		{
			location: { type: "organization" },
			name: "All team members",
			folders: organizationFolders.filter(
				(folder) => folder.spaceId === organizationId,
			),
		},
		...availableSpaces.map(
			(space): MoveDestinationGroup => ({
				location: { type: "space", spaceId: space.id },
				name: space.name,
				folders: organizationFolders.filter(
					(folder) => folder.spaceId === space.id,
				),
			}),
		),
	];
}

export async function placeOwnedVideos({
	videoIds,
	folderId,
	location,
	organizationId: requestedOrganizationId,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	location: MoveLocation;
	organizationId?: Organisation.OrganisationId;
}) {
	const user = await getCurrentUser();
	const organizationId = requestedOrganizationId ?? user?.activeOrganizationId;
	if (!user || !organizationId) throw new Error("Unauthorized");
	requireValidLocation(location);
	const ids = normalizeVideoIds(videoIds).sort();
	const organizationAccess = await requireOrganizationAccess(
		user.id,
		organizationId,
	);
	if (location.type === "space") {
		const access = await getSpaceAccess(user.id, location.spaceId);
		if (
			!access ||
			access.organizationId !== organizationId ||
			!access.organizationRole ||
			(!access.canManage && !access.spaceRole)
		) {
			throw new Error("Space not found");
		}
	}
	await db().transaction(async (tx) => {
		if (location.type === "space") {
			const [space] = await tx
				.select({
					createdById: spaces.createdById,
					memberRole: spaceMembers.role,
				})
				.from(spaces)
				.leftJoin(
					spaceMembers,
					and(
						eq(spaceMembers.spaceId, spaces.id),
						eq(spaceMembers.userId, user.id),
					),
				)
				.where(
					and(
						eq(spaces.id, location.spaceId),
						eq(spaces.organizationId, organizationId),
					),
				)
				.limit(1)
				.for("update");
			if (
				!space ||
				(!canManageOrganizationSettings(organizationAccess.role) &&
					!getEffectiveSpaceRole({
						userId: user.id,
						createdById: space.createdById,
						memberRole: space.memberRole,
					}))
			) {
				throw new Error("Space not found");
			}
		}
		const ownedVideos = await tx
			.select({ id: videos.id })
			.from(videos)
			.where(
				and(
					inArray(videos.id, ids),
					eq(videos.ownerId, user.id),
					eq(videos.orgId, organizationId),
				),
			)
			.orderBy(asc(videos.id))
			.for("update");
		if (ownedVideos.length !== ids.length)
			throw new Error("One or more Caps cannot be moved");
		if (folderId) {
			const [folder] = await tx
				.select({ id: folders.id })
				.from(folders)
				.where(
					and(
						eq(folders.id, folderId),
						getFolderScope(user, location, organizationId),
					),
				)
				.limit(1)
				.for("update");
			if (!folder) throw new Error("Destination folder not found");
		}
		if (location.type === "personal") {
			await tx.update(videos).set({ folderId }).where(inArray(videos.id, ids));
		} else if (location.type === "organization") {
			const existing = await tx
				.select({ videoId: sharedVideos.videoId })
				.from(sharedVideos)
				.where(
					and(
						inArray(sharedVideos.videoId, ids),
						eq(sharedVideos.organizationId, organizationId),
					),
				);
			const shared = new Set(existing.map((row) => row.videoId));
			const missing = ids.filter((id) => !shared.has(id));
			if (missing.length)
				await tx.insert(sharedVideos).values(
					missing.map((videoId) => ({
						id: nanoId(),
						videoId,
						folderId,
						organizationId,
						sharedByUserId: user.id,
					})),
				);
			await tx
				.update(sharedVideos)
				.set({ folderId })
				.where(
					and(
						inArray(sharedVideos.videoId, ids),
						eq(sharedVideos.organizationId, organizationId),
					),
				);
		} else {
			const existing = await tx
				.select({ videoId: spaceVideos.videoId })
				.from(spaceVideos)
				.where(
					and(
						inArray(spaceVideos.videoId, ids),
						eq(spaceVideos.spaceId, location.spaceId),
					),
				);
			const shared = new Set(existing.map((row) => row.videoId));
			const missing = ids.filter((id) => !shared.has(id));
			if (missing.length)
				await tx.insert(spaceVideos).values(
					missing.map((videoId) => ({
						id: nanoId(),
						videoId,
						folderId,
						spaceId: location.spaceId,
						addedById: user.id,
					})),
				);
			await tx
				.update(spaceVideos)
				.set({ folderId })
				.where(
					and(
						inArray(spaceVideos.videoId, ids),
						eq(spaceVideos.spaceId, location.spaceId),
					),
				);
		}
	});
	revalidateMoveLocation(location);
	revalidatePath("/s/[videoId]", "page");
	return { moved: ids.length };
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
