import { Caps } from "./Caps";
import { db } from "@cap/database";
import {
  comments,
  videos,
  sharedVideos,
  spaces,
  users,
  spaceMembers,
} from "@cap/database/schema";
import { desc, eq, sql, count, or } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "My Caps — Cap",
};

export const revalidate = 0;

export default async function CapsPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const page = Number(searchParams.page) || 1;
  const limit = Number(searchParams.limit) || 15;
  const user = await getCurrentUser();
  const userId = user?.id as string;
  const offset = (page - 1) * limit;

  const totalCountResult = await db
    .select({ count: count() })
    .from(videos)
    .where(eq(videos.ownerId, userId));

  const totalCount = totalCountResult[0]?.count || 0;

  const videoData = await db
    .select({
      id: videos.id,
      ownerId: videos.ownerId,
      name: videos.name,
      createdAt: videos.createdAt,
      totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
      totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
      sharedSpaces: sql<{ id: string; name: string }[]>`
        COALESCE(
          JSON_ARRAYAGG(
            JSON_OBJECT(
              'id', ${spaces.id},
              'name', ${spaces.name}
            )
          ),
          JSON_ARRAY()
        )
      `,
      ownerName: users.name,
    })
    .from(videos)
    .leftJoin(comments, eq(videos.id, comments.videoId))
    .leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
    .leftJoin(spaces, eq(sharedVideos.spaceId, spaces.id))
    .leftJoin(users, eq(videos.ownerId, users.id))
    .where(eq(videos.ownerId, userId))
    .groupBy(
      videos.id,
      videos.ownerId,
      videos.name,
      videos.createdAt,
      users.name
    )
    .orderBy(desc(videos.createdAt))
    .limit(limit)
    .offset(offset);

  const userSpaces = await db
    .select({
      id: spaces.id,
      name: spaces.name,
    })
    .from(spaces)
    .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
    .where(eq(spaceMembers.userId, userId));

  const processedVideoData = videoData.map((video) => ({
    ...video,
    sharedSpaces: video.sharedSpaces.filter((space) => space.id !== null),
  }));

  return (
    <Caps
      data={processedVideoData}
      count={totalCount}
      userSpaces={userSpaces}
    />
  );
}
