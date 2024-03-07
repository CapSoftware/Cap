import { Caps } from "./Caps";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { desc, eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";

export const revalidate = 0;

export default async function CapsPage() {
  const user = await getCurrentUser();
  const userId = user?.userId as string;

  const videoData = await db
    .select()
    .from(videos)
    .orderBy(desc(videos.createdAt))
    .where(eq(videos.ownerId, userId));

  return <Caps data={videoData} />;
}
