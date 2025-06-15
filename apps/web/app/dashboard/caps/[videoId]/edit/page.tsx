import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { VideoEditor } from "@/components/VideoEditor";

export const revalidate = 0;

export default async function EditCapPage({
  params,
}: {
  params: { videoId: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const videoId = params.videoId;
  const [video] = await db()
    .select()
    .from(videos)
    .where(eq(videos.id, videoId));

  if (!video || video.ownerId !== user.id) {
    redirect("/dashboard/caps");
  }

  const playlistUrl = `/api/playlist?userId=${video.ownerId}&videoId=${video.id}`;

  return <VideoEditor videoId={video.id} playlistUrl={playlistUrl} />;
}
