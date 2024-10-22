"use server";
import { Share } from "./Share";
import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import { videos, comments } from "@cap/database/schema";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";
import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { ImageViewer } from "./_components/ImageViewer";
type Props = {
  params: { [key: string]: string | string[] | undefined };
};

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {
  const videoId = params.videoId as string;
  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return notFound();
  }

  const video = query[0];

  if (!video) {
    return notFound();
  }

  if (video.public === false) {
    return {
      title: "Cap: This video is private",
      description: "This video is private and cannot be shared.",
      openGraph: {
        images: [
          `${process.env.NEXT_PUBLIC_URL}/api/video/og?videoId=${videoId}`,
        ],
      },
    };
  }

  return {
    title: "Cap: " + video.name,
    description: "Watch this video on Cap",
    openGraph: {
      images: [
        `${process.env.NEXT_PUBLIC_URL}/api/video/og?videoId=${videoId}`,
      ],
    },
  };
}

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;
  const user = (await getCurrentUser()) as typeof userSelectProps | null;
  const userId = user?.id as string | undefined;
  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return <p>No video found</p>;
  }

  const video = query[0];

  if (!video) {
    return notFound();
  }

  if (
    video.jobId === null &&
    video.skipProcessing === false &&
    video.source.type === "MediaConvert"
  ) {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/upload/mux/create?videoId=${videoId}&userId=${video.ownerId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );

    await res.json();
  }

  if (video.transcriptionStatus !== "COMPLETE") {
    fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/video/transcribe?videoId=${videoId}&userId=${video.ownerId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );
  }

  if (video.public === false && userId !== video.ownerId) {
    return <p>This video is private</p>;
  }

  const commentsQuery = await db
    .select()
    .from(comments)
    .where(eq(comments.videoId, videoId));

  let screenshotUrl;
  if (video.isScreenshot === true) {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/screenshot?userId=${video.ownerId}&screenshotId=${videoId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );
    const data = await res.json();
    screenshotUrl = data.url;

    return (
      <ImageViewer
        imageSrc={screenshotUrl}
        data={video}
        user={user}
        comments={commentsQuery}
      />
    );
  }

  let individualFiles: {
    fileName: string;
    url: string;
  }[] = [];

  if (video?.source.type === "desktopMP4") {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/video/individual?videoId=${videoId}&userId=${video.ownerId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );

    const data = await res.json();
    individualFiles = data.files;
  }

  return (
    <Share
      data={video}
      user={user}
      comments={commentsQuery}
      individualFiles={individualFiles}
    />
  );
}
