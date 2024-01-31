"use server";
import { Share } from "./Share";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { videos } from "@cap/database/schema";

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;

  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return <p>No video found</p>;
  }

  const video = query[0];

  return <Share data={video} />;
}
