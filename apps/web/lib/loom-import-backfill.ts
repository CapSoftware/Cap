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
import { getOrganizationMemberByEmail } from "@/lib/loom-csv-import";
import { reassignLoomImport } from "@/lib/loom-import-reassign";
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
};

export async function backfillLoomImport(
	organizationId: string,
	item: LoomBackfillItem,
): Promise<LoomBackfillOutcome> {
	const orgId = Organisation.OrganisationId.make(organizationId);
	const id = Video.VideoId.make(item.videoId);
	const changes: string[] = [];
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			folderId: videos.folderId,
			effectiveCreatedAt: videos.effectiveCreatedAt,
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
	if (!video)
		return {
			videoId: item.videoId,
			status: "skipped",
			changes,
			reason: "not a Loom import here",
		};

	const personalFolder = item.folderId
		? await findFolder(orgId, item.folderId, false)
		: undefined;
	if (item.folderId && !personalFolder)
		return {
			videoId: item.videoId,
			status: "skipped",
			changes,
			reason: "folder not in this workspace",
		};
	const sharedFolder = item.shareFolderId
		? await findFolder(orgId, item.shareFolderId, true)
		: undefined;
	if (item.shareFolderId && !sharedFolder)
		return {
			videoId: item.videoId,
			status: "skipped",
			changes,
			reason: "shared folder not in this workspace",
		};

	let ownerId = video.ownerId;
	if (item.ownerEmail) {
		const email = item.ownerEmail.trim().toLowerCase();
		const existingMember = await getOrganizationMemberByEmail(orgId, email);
		const member =
			existingMember ??
			(await provisionOrganizationInvitee({
				organizationId: orgId,
				email,
				invitedByUserId: video.orgOwnerId,
				role: "member",
			}).then((provisioned) => ({ userId: provisioned.userId, email })));
		if (!member)
			return {
				videoId: item.videoId,
				status: "failed",
				changes,
				reason: "could not add the owner to the workspace",
			};
		if (member.userId !== video.ownerId) {
			const moved = await reassignLoomImport({
				organizationId,
				videoId: item.videoId,
				fromUserId: video.ownerId,
				toUserId: member.userId,
				options: {
					keepSharing: true,
					folderId: personalFolder?.id ?? video.folderId,
				},
			});
			if (moved.status !== "moved")
				return {
					videoId: item.videoId,
					status: moved.status,
					changes,
					reason: moved.reason,
				};
			ownerId = User.UserId.make(member.userId);
			changes.push("owner");
			if (personalFolder && personalFolder.id !== video.folderId)
				changes.push("folder");
		}
	}

	if (
		personalFolder &&
		personalFolder.id !== video.folderId &&
		!changes.includes("folder")
	) {
		await db()
			.update(videos)
			.set({ folderId: personalFolder.id })
			.where(and(eq(videos.id, id), eq(videos.ownerId, ownerId)));
		changes.push("folder");
	}

	if (item.effectiveCreatedAt) {
		const date = new Date(item.effectiveCreatedAt);
		if (Number.isNaN(date.getTime()))
			return {
				videoId: item.videoId,
				status: "failed",
				changes,
				reason: "invalid date",
			};
		if (video.effectiveCreatedAt?.getTime() !== date.getTime()) {
			await db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.customCreatedAt', ${date.toISOString()})`,
				})
				.where(eq(videos.id, id));
			changes.push("date");
		}
	}

	if (sharedFolder) {
		const [share] = await db()
			.select({ id: sharedVideos.id, folderId: sharedVideos.folderId })
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.videoId, id),
					eq(sharedVideos.organizationId, orgId),
				),
			)
			.limit(1);
		if (!share) {
			await db().insert(sharedVideos).values({
				id: nanoId(),
				videoId: id,
				organizationId: orgId,
				folderId: sharedFolder.id,
				sharedByUserId: ownerId,
			});
			changes.push("shared");
		} else if (share.folderId !== sharedFolder.id) {
			await db()
				.update(sharedVideos)
				.set({ folderId: sharedFolder.id })
				.where(eq(sharedVideos.id, share.id));
			changes.push("shared");
		}
	}

	return {
		videoId: item.videoId,
		status: changes.length > 0 ? "updated" : "unchanged",
		changes,
	};
}

async function findFolder(
	organizationId: Organisation.OrganisationId,
	folderId: string,
	shared: boolean,
) {
	const [folder] = await db()
		.select({ id: folders.id })
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
