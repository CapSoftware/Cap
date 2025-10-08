"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	comments,
	folders,
	spaces,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { desc, eq, sql } from "drizzle-orm";

export async function getUserVideos(spaceId: string) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		const userId = user.id;

		const videoData = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				name: videos.name,
				createdAt: videos.createdAt,
				metadata: videos.metadata,
				totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
				totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
				ownerName: users.name,
				folderName: sql<string>`CASE WHEN ${folders.spaceId} = ${spaceId} THEN ${folders.name} ELSE NULL END`,
				folderColor: sql<string>`CASE WHEN ${folders.spaceId} = ${spaceId} THEN ${folders.color} ELSE NULL END`,
				effectiveDate: sql<string>`
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
            ${videos.createdAt}
          )
        `,
				hasActiveUpload: sql`${videoUploads.videoId} IS NOT NULL`.mapWith(
					Boolean,
				),
			})
			.from(videos)
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
			.leftJoin(folders, eq(videos.folderId, folders.id))
			.leftJoin(spaces, eq(folders.spaceId, spaces.id))
			.where(eq(videos.ownerId, userId))
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
