import { Caps } from "./Caps";
import { db } from "@cap/database";
import { comments, videos } from "@cap/database/schema";
import { desc, eq, sql } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export const revalidate = 0;

export default async function CapsPage() {
  const user = await getCurrentUser();
  const userId = user?.id as string;

  if (user !== null && (user.name === null || user.name.length === 0)) {
    return redirect("/onboarding");
  }

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
    .orderBy(desc(videos.createdAt));

  return <Caps data={videoData} />;
}
