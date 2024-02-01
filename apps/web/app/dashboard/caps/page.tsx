import { Caps } from "./Caps";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { desc } from "drizzle-orm";

export const revalidate = 0;

export default async function CapsPage() {
  const videoData = await db
    .select()
    .from(videos)
    .orderBy(desc(videos.createdAt));

  return <Caps data={videoData} />;
}
