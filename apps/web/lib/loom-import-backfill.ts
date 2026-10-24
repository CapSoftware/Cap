import "server-only";

import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	folders,
	importedVideos,
	organizations,
	sharedVideos,
	videos,
} from "@cap/database/schema";
import { Folder, Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
	getOrganizationMemberByEmail,
	isValidImportEmail,
	normalizeImportEmail,
} from "@/lib/loom-csv-import";
import { reassignLoomImport } from "@/lib/loom-import-reassign";
import { getOwnerOriginalKey } from "@/lib/loom-original-key";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";

export type LoomBackfillItem = {
	videoId: string;
	ownerEmail?: string;
	folderId?: string;
	effectiveCreatedAt?: string;
	shareFolderId?: string;
};

export type LoomBackfillOutcome = {
	videoId: string;
	status: "updated" | "unchanged" | "skipped" | "failed";
	changes: string[];
	reason?: string;
	warning?: string;
};

type FolderRow = { id: Folder.FolderId; createdById: User.UserId };

export async function backfillLoomImport(
	organizationId: string,
	item: LoomBackfillItem,
): Promise<LoomBackfillOutcome> {
	const orgId = Organisation.OrganisationId.make(organizationId);
	const id = Video.VideoId.make(item.videoId);
	const changes: string[] = [];
	const result = (
		status: LoomBackfillOutcome["status"],
		extra: Partial<LoomBackfillOutcome> = {},
	): LoomBackfillOutcome => ({
		videoId: item.videoId,
		status,
		changes,
		...extra,
	});
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			folderId: videos.folderId,
			effectiveCreatedAt: videos.effectiveCreatedAt,
			metadata: videos.metadata,
			orgOwnerId: organizations.ownerId,
		})
		.from(videos)
		.innerJoin(
			importedVideos,
			and(
				eq(importedVideos.id, videos.id),
				eq(importedVideos.orgId, videos.orgId),
				eq(importedVideos.source, "loom"),
			),
		)
		.innerJoin(organizations, eq(organizations.id, videos.orgId))
		.where(and(eq(videos.id, id), eq(videos.orgId, orgId)))
		.limit(1);
	if (!video) return result("skipped", { reason: "not a Loom import here" });

	const date = item.effectiveCreatedAt
		? new Date(item.effectiveCreatedAt)
		: undefined;
	if (date && Number.isNaN(date.getTime()))
		return result("failed", { reason: "invalid date" });

	const email =
		item.ownerEmail !== undefined
			? normalizeImportEmail(item.ownerEmail)
			: undefined;
	if (email !== undefined && !isValidImportEmail(email))
		return result("skipped", { reason: "invalid owner email" });

	const personalFolder = item.folderId
		? await findFolder(orgId, item.folderId, false)
		: undefined;
	if (item.folderId && !personalFolder)
		return result("skipped", { reason: "folder not in this workspace" });
	const sharedFolder = item.shareFolderId
		? await findFolder(orgId, item.shareFolderId, true)
		: undefined;
	if (item.shareFolderId && !sharedFolder)
		return result("skipped", {
			reason: "shared folder not in this workspace",
		});

	let ownerId = video.ownerId;
	if (email) {
		const member =
			(await getOrganizationMemberByEmail(orgId, email)) ??
			(await provisionOrganizationInvitee({
				organizationId: orgId,
				email,
				invitedByUserId: video.orgOwnerId,
				role: "member",
			}).then((provisioned) => ({ userId: provisioned.userId, email })));
		if (!member)
			return result("failed", {
				reason: "could not add the owner to the workspace",
			});
		ownerId = User.UserId.make(member.userId);
	}

	const canUseFolder = (folder: FolderRow) =>
		folder.createdById === ownerId || folder.createdById === video.orgOwnerId;
	if (personalFolder && !canUseFolder(personalFolder))
		return result("skipped", {
			reason: "folder belongs to someone other than the owner",
		});
	const currentFolder = video.folderId
		? await findFolder(orgId, video.folderId, false)
		: undefined;
	const targetFolderId =
		personalFolder?.id ??
		(currentFolder && canUseFolder(currentFolder) ? currentFolder.id : null);

	let warning: string | undefined;
	if (ownerId !== video.ownerId) {
		const moved = await reassignLoomImport({
			organizationId,
			videoId: item.videoId,
			fromUserId: video.ownerId,
			toUserId: ownerId,
			options: { keepSharing: true, folderId: targetFolderId },
		});
		if (moved.status !== "moved")
			return result(moved.status, { reason: moved.reason });
		if (moved.cleanup === "failed")
			warning = "old owner's files could not be removed";
		changes.push("owner");
		if (targetFolderId !== video.folderId) changes.push("folder");
	} else if (targetFolderId !== video.folderId) {
		await db()
			.update(videos)
			.set({ folderId: targetFolderId })
			.where(and(eq(videos.id, id), eq(videos.ownerId, ownerId)));
		changes.push("folder");
	}

	const deferredKey = video.metadata?.loomDeferredProcessing?.rawFileKey;
	const repairedKey = getOwnerOriginalKey(deferredKey, ownerId, item.videoId);
	if (
		ownerId === video.ownerId &&
		video.metadata?.loomDeferredProcessing?.status === "pending" &&
		repairedKey &&
		repairedKey !== deferredKey
	) {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey', ${repairedKey})`,
			})
			.where(
				and(
					eq(videos.id, id),
					eq(videos.ownerId, ownerId),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.loomDeferredProcessing.rawFileKey')) = ${deferredKey}`,
				),
			);
		changes.push("original");
	}

	if (date && video.effectiveCreatedAt?.getTime() !== date.getTime()) {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.customCreatedAt', ${date.toISOString()})`,
			})
			.where(eq(videos.id, id));
		changes.push("date");
	}

	if (sharedFolder) {
		const shared = await db().transaction(async (tx) => {
			await tx
				.select({ id: videos.id })
				.from(videos)
				.where(eq(videos.id, id))
				.for("update");
			const shares = await tx
				.select({ id: sharedVideos.id, folderId: sharedVideos.folderId })
				.from(sharedVideos)
				.where(
					and(
						eq(sharedVideos.videoId, id),
						eq(sharedVideos.organizationId, orgId),
					),
				);
			const [keep, ...duplicates] = shares;
			for (const duplicate of duplicates)
				await tx.delete(sharedVideos).where(eq(sharedVideos.id, duplicate.id));
			if (!keep) {
				await tx.insert(sharedVideos).values({
					id: nanoId(),
					videoId: id,
					organizationId: orgId,
					folderId: sharedFolder.id,
					sharedByUserId: ownerId,
				});
				return true;
			}
			if (keep.folderId === sharedFolder.id && duplicates.length === 0)
				return false;
			await tx
				.update(sharedVideos)
				.set({ folderId: sharedFolder.id })
				.where(eq(sharedVideos.id, keep.id));
			return true;
		});
		if (shared) changes.push("shared");
	}

	return result(changes.length > 0 ? "updated" : "unchanged", { warning });
}

async function findFolder(
	organizationId: Organisation.OrganisationId,
	folderId: string,
	shared: boolean,
): Promise<FolderRow | undefined> {
	const [folder] = await db()
		.select({ id: folders.id, createdById: folders.createdById })
		.from(folders)
		.where(
			and(
				eq(folders.id, Folder.FolderId.make(folderId)),
				eq(folders.organizationId, organizationId),
				shared ? eq(folders.spaceId, organizationId) : isNull(folders.spaceId),
			),
		)
		.limit(1);
	return folder;
}
