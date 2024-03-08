"use server";
import { Share } from "./Share";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { videos, comments } from "@cap/database/schema";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;
  const user = (await getCurrentUser()) as typeof userSelectProps | null;
  const userId = user?.userId as string | undefined;

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return <p>No video found</p>;
  }

  const video = query[0];

  if (video.public === false) {
    if (video.public === false && userId !== video.ownerId) {
      return <p>Video is private</p>;
    }
  }

  const commentsQuery = await db
    .select()
    .from(comments)
    .where(eq(comments.videoId, videoId));

  return <Share data={video} user={user} comments={commentsQuery} />;
}
