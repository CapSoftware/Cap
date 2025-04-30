import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  comments,
  sharedVideos,
  spaceMembers,
  spaces,
  users,
  videos,
} from "@cap/database/schema";
import { count, desc, eq, sql } from "drizzle-orm";
import { Metadata } from "next";
import { SharedCaps } from "./SharedCaps";

export const metadata: Metadata = {
  title: "Shared Caps — Cap",
};

export const revalidate = 0;

export default async function SharedCapsPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const page = Number(searchParams.page) || 1;
  const limit = Number(searchParams.limit) || 15;
  const user = await getCurrentUser();
  const userId = user?.id as string;

  let activeSpaceId = user?.activeSpaceId;
  if (!activeSpaceId) {
    // Get the first available space if activeSpaceId doesn't exist
    const firstSpace = await db()
      .select({ id: spaces.id })
      .from(spaces)
      .innerJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, userId))
      .limit(1)
      .then((result) => result[0]);

    activeSpaceId = firstSpace?.id;
  }

  if (!activeSpaceId) {
    // Handle the case where the user has no spaces
    return <div>No spaces available. Please create or join a space.</div>;
  }

  const offset = (page - 1) * limit;

  const totalCountResult = await db()
    .select({ count: count() })
    .from(sharedVideos)
    .where(eq(sharedVideos.spaceId, activeSpaceId));

  const totalCount = totalCountResult[0]?.count || 0;

  const sharedVideoData = await db()
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
    .from(sharedVideos)
    .innerJoin(videos, eq(sharedVideos.videoId, videos.id))
    .leftJoin(comments, eq(videos.id, comments.videoId))
    .leftJoin(users, eq(videos.ownerId, users.id))
    .where(eq(sharedVideos.spaceId, activeSpaceId))
    .groupBy(
      videos.id,
      videos.ownerId,
      videos.name,
      videos.createdAt,
      videos.metadata,
      users.name
    )
    .orderBy(
      desc(sql`COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
      ${videos.createdAt}
    )`)
    )
    .limit(limit)
    .offset(offset);

  // Process the data to clean it up and remove the temporary effectiveDate field
  const processedSharedVideoData = sharedVideoData.map((video) => {
    const { effectiveDate, ...videoWithoutEffectiveDate } = video;

    return {
      ...videoWithoutEffectiveDate,
      ownerName: video.ownerName ?? null,
      metadata: video.metadata as
        | {
            customCreatedAt?: string;
            [key: string]: any;
          }
        | undefined,
    };
  });

  console.log("sharedVideoData:");
  console.log(processedSharedVideoData);

  // Debug: Check if there are any shared videos for this space
  const debugSharedVideos = await db()
    .select({
      id: sharedVideos.id,
      videoId: sharedVideos.videoId,
      spaceId: sharedVideos.spaceId,
    })
    .from(sharedVideos)
    .where(eq(sharedVideos.spaceId, activeSpaceId));

  console.log("Debug: Shared videos for this space:");
  console.log(debugSharedVideos);

  // Debug: Check if the videos exist
  if (debugSharedVideos.length > 0) {
    const debugVideos = await db()
      .select({
        id: videos.id,
        name: videos.name,
        ownerId: videos.ownerId,
      })
      .from(videos)
      .where(eq(videos.id, debugSharedVideos[0]!.videoId));

    console.log("Debug: Video details:");
    console.log(debugVideos);
  }

  return <SharedCaps data={processedSharedVideoData} count={totalCount} />;
}
