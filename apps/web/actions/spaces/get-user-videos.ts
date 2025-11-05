"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	organizations,
	sharedVideos,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { Space } from "@cap/web-domain";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

export async function getUserVideos(spaceId: Space.SpaceIdOrOrganisationId) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		const userId = user.id;
		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		const selectFields = {
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			createdAt: videos.createdAt,
			metadata: videos.metadata,
			totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
			totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
			ownerName: users.name,
			folderName: folders.name,
			folderColor: folders.color,
			effectiveDate: sql<string>`
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
            ${videos.createdAt}
          )
        `,
			hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
				Boolean,
			),
		};

		const videoData = isAllSpacesEntry
			? await db()
					.select(selectFields)
					.from(videos)
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.leftJoin(
						sharedVideos,
						and(
							eq(videos.id, sharedVideos.videoId),
							eq(sharedVideos.organizationId, spaceId),
						),
					)
					.leftJoin(folders, eq(sharedVideos.folderId, folders.id))
					.leftJoin(spaces, eq(folders.spaceId, spaces.id))
					.leftJoin(organizations, eq(videos.orgId, organizations.id))
					.where(
						and(eq(videos.ownerId, userId), isNull(organizations.tombstoneAt)),
					)
					.groupBy(
						videos.id,
						videos.ownerId,
						videos.name,
						videos.createdAt,
						videos.metadata,
						users.name,
						folders.name,
						folders.color,
						folders.spaceId,
						videos.folderId,
					)
					.orderBy(
						desc(sql`COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )`),
					)
			: await db()
					.select(selectFields)
					.from(videos)
					.leftJoin(comments, eq(videos.id, comments.videoId))
					.leftJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.leftJoin(
						spaceVideos,
						and(
							eq(videos.id, spaceVideos.videoId),
							eq(spaceVideos.spaceId, spaceId),
						),
					)
					.leftJoin(folders, eq(spaceVideos.folderId, folders.id))
					.leftJoin(spaces, eq(folders.spaceId, spaces.id))
					.leftJoin(organizations, eq(videos.orgId, organizations.id))
					.where(
						and(eq(videos.ownerId, userId), isNull(organizations.tombstoneAt)),
					)
					.groupBy(
						videos.id,
						videos.ownerId,
						videos.name,
						videos.createdAt,
						videos.metadata,
						users.name,
						folders.name,
						folders.color,
						folders.spaceId,
						videos.folderId,
					)
					.orderBy(
						desc(sql`COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )`),
					);

		const processedVideoData = videoData.map((video) => {
			const { effectiveDate: _effectiveDate, ...videoWithoutEffectiveDate } =
				video;
			return {
				...videoWithoutEffectiveDate,
				ownerName: video.ownerName ?? "",
				folderName: video.folderName ?? null,
				folderColor: video.folderColor ?? null,
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: unknown }
					| undefined,
			};
		});

		return { success: true, data: processedVideoData };
	} catch (error) {
		console.error("Error fetching user videos:", error);
		return { success: false, error: "Failed to fetch videos" };
	}
}
