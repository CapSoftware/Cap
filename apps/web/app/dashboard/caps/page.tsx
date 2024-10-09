import { Caps } from "./Caps";
import { db } from "@cap/database";
import { comments, videos } from "@cap/database/schema";
import { desc, eq, sql, count } from "drizzle-orm";
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
      totalComments: sql<number>`COUNT(CASE WHEN ${comments.type} = 'text' THEN 1 END)`,
      totalReactions: sql<number>`COUNT(CASE WHEN ${comments.type} = 'emoji' THEN 1 END)`,
    })
    .from(videos)
    .leftJoin(comments, eq(videos.id, comments.videoId))
    .where(eq(videos.ownerId, userId))
    .groupBy(videos.id, videos.ownerId, videos.name, videos.createdAt)
    .orderBy(desc(videos.createdAt))
    .limit(limit)
    .offset(offset);

  return <Caps data={videoData} count={totalCount} />;
}
