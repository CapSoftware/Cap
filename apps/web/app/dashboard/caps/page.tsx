import { Caps } from "./Caps";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";

export const revalidate = 0;

export default async function CapsPage() {
  const videoData = await db.select().from(videos);

  return <Caps data={videoData} />;
}
