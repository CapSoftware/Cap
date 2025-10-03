"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { comments, users, videos } from "@cap/database/schema";
import { desc, eq, sql } from "drizzle-orm";

export async function getUserVideos(limit?: number) {
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
				effectiveDate: sql<string>`
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
            ${videos.createdAt}
          )
        `,
			})
			.from(videos)
			.leftJoin(comments, eq(videos.id, comments.videoId))
			.leftJoin(users, eq(videos.ownerId, users.id))
			.where(eq(videos.ownerId, userId))
			.groupBy(
				videos.id,
				videos.ownerId,
				videos.name,
				videos.createdAt,
				videos.metadata,
				users.name,
			)
			.orderBy(
				desc(sql`COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )`),
			)
			.limit(limit || 20);

		const processedVideoData = videoData.map((video) => {
			const { effectiveDate, ...videoWithoutEffectiveDate } = video;
			return {
				...videoWithoutEffectiveDate,
				ownerName: video.ownerName ?? "",
				metadata: video.metadata as
					| { customCreatedAt?: string; [key: string]: any }
					| undefined,
			};
		});

		return { success: true, data: processedVideoData };
	} catch (error) {
		console.error("Error fetching user videos:", error);
		return { success: false, error: "Failed to fetch videos" };
	}
}
