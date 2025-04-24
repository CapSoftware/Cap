import { Share } from "./Share";
import { db } from "@cap/database";
import { eq, desc, sql, count } from "drizzle-orm";
import {
  videos,
  comments,
  users,
  sharedVideos,
  spaceMembers,
  spaces,
} from "@cap/database/schema";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";
import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { ImageViewer } from "./_components/ImageViewer";
import { clientEnv } from "@cap/env";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";

export const dynamic = "auto";
export const dynamicParams = true;
export const revalidate = 30;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

type CommentWithAuthor = typeof comments.$inferSelect & {
  authorName: string | null;
};

type VideoWithSpace = typeof videos.$inferSelect & {
  sharedSpace?: {
    spaceId: string;
  } | null;
  spaceMembers?: string[];
  spaceId?: string;
};

type SpaceMember = {
  userId: string;
};

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {
  const videoId = params.videoId as string;
  console.log(
    "[generateMetadata] Fetching video metadata for videoId:",
    videoId
  );
  const query = await db.select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    console.log("[generateMetadata] No video found for videoId:", videoId);
    return notFound();
  }

  const video = query[0];

  if (!video) {
    console.log(
      "[generateMetadata] Video object is null for videoId:",
      videoId
    );
    return notFound();
  }

  if (video.public === false) {
    console.log(
      "[generateMetadata] Video is private, returning private metadata"
    );
    return {
      title: "Cap: This video is private",
      description: "This video is private and cannot be shared.",
      openGraph: {
        images: [`${serverEnv.WEB_URL}/api/video/og?videoId=${videoId}`],
      },
    };
  }

  console.log(
    "[generateMetadata] Returning public metadata for video:",
    video.name
  );
  return {
    title: video.name + " | Cap Recording",
    description: "Watch this video on Cap",
    openGraph: {
      images: [`${serverEnv.WEB_URL}/api/video/og?videoId=${videoId}`],
    },
  };
}

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;
  console.log("[ShareVideoPage] Starting page load for videoId:", videoId);

  const user = (await getCurrentUser()) as typeof userSelectProps | null;
  const userId = user?.id as string | undefined;
  console.log("[ShareVideoPage] Current user:", userId);

  const videoWithSpace = await db
    .select({
      id: videos.id,
      name: videos.name,
      ownerId: videos.ownerId,
      createdAt: videos.createdAt,
      updatedAt: videos.updatedAt,
      awsRegion: videos.awsRegion,
      awsBucket: videos.awsBucket,
      bucket: videos.bucket,
      metadata: videos.metadata,
      public: videos.public,
      videoStartTime: videos.videoStartTime,
      audioStartTime: videos.audioStartTime,
      xStreamInfo: videos.xStreamInfo,
      jobId: videos.jobId,
      jobStatus: videos.jobStatus,
      isScreenshot: videos.isScreenshot,
      skipProcessing: videos.skipProcessing,
      transcriptionStatus: videos.transcriptionStatus,
      source: videos.source,
      sharedSpace: {
        spaceId: sharedVideos.spaceId,
      },
    })
    .from(videos)
    .leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
    .where(eq(videos.id, videoId))
    .execute();

  const video = videoWithSpace[0];

  if (!video) {
    console.log("[ShareVideoPage] No video found for videoId:", videoId);
    return <p>No video found</p>;
  }

  if (video.sharedSpace?.spaceId) {
    const space = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, video.sharedSpace.spaceId))
      .limit(1);

    if (space[0]?.allowedEmailDomain) {
      if (
        !user?.email ||
        !user.email.endsWith(`@${space[0].allowedEmailDomain}`)
      ) {
        console.log(
          "[ShareVideoPage] Access denied - domain restriction:",
          space[0].allowedEmailDomain
        );
        return (
          <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
            <h1 className="text-2xl font-bold mb-4">Access Restricted</h1>
            <p className="text-gray-600 mb-2">
              This video is only accessible to members of this organization.
            </p>
            <p className="text-gray-600">
              Please sign in with your organization email address to access this
              content.
            </p>
          </div>
        );
      }
    }
  }

  const videoSource = video.source as (typeof videos.$inferSelect)["source"];

  if (
    video.jobId === null &&
    video.skipProcessing === false &&
    videoSource.type === "MediaConvert"
  ) {
    console.log("[ShareVideoPage] Creating MUX job for video:", videoId);
    const res = await fetch(
      `${serverEnv.WEB_URL}/api/upload/mux/create?videoId=${videoId}&userId=${video.ownerId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );

    await res.json();
  }

  if (video.transcriptionStatus !== "COMPLETE") {
    console.log("[ShareVideoPage] Starting transcription for video:", videoId);
    fetch(
      `${serverEnv.WEB_URL}/api/video/transcribe?videoId=${videoId}&userId=${video.ownerId}`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      }
    );
  }

  if (video.public === false && userId !== video.ownerId) {
    console.log("[ShareVideoPage] Access denied - private video:", videoId);
    return <p>This video is private</p>;
  }

  console.log("[ShareVideoPage] Fetching comments for video:", videoId);
  const commentsQuery: CommentWithAuthor[] = await db
    .select({
      id: comments.id,
      content: comments.content,
      timestamp: comments.timestamp,
      type: comments.type,
      authorId: comments.authorId,
      videoId: comments.videoId,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      parentCommentId: comments.parentCommentId,
      authorName: users.name,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(eq(comments.videoId, videoId));

  let screenshotUrl;
  if (video.isScreenshot === true) {
    console.log("[ShareVideoPage] Fetching screenshot for video:", videoId);
    const res = await fetch(
      `${serverEnv.WEB_URL}/api/screenshot?userId=${video.ownerId}&screenshotId=${videoId}`,
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

  console.log("[ShareVideoPage] Fetching analytics for video:", videoId);
  const analyticsData = await getVideoAnalytics(videoId);

  const initialAnalytics = {
    views: analyticsData.count || 0,
    comments: commentsQuery.filter((c) => c.type === "text").length,
    reactions: commentsQuery.filter((c) => c.type === "emoji").length,
  };

  // Fetch custom domain information
  let customDomain: string | null = null;
  let domainVerified = false;

  // Check if the video is shared with a space
  if (video.sharedSpace?.spaceId) {
    const spaceData = await db
      .select({
        customDomain: spaces.customDomain,
        domainVerified: spaces.domainVerified,
      })
      .from(spaces)
      .where(eq(spaces.id, video.sharedSpace.spaceId))
      .limit(1);

    if (spaceData.length > 0 && spaceData[0] && spaceData[0].customDomain) {
      customDomain = spaceData[0].customDomain;
      // Handle domainVerified which could be a Date or boolean
      if (spaceData[0].domainVerified !== null) {
        domainVerified = true; // If it exists (not null), consider it verified
      }
    }
  }

  // If no custom domain from shared space, check the owner's space
  if (!customDomain && video.ownerId) {
    const ownerSpaces = await db
      .select({
        customDomain: spaces.customDomain,
        domainVerified: spaces.domainVerified,
      })
      .from(spaces)
      .where(eq(spaces.ownerId, video.ownerId))
      .limit(1);

    if (
      ownerSpaces.length > 0 &&
      ownerSpaces[0] &&
      ownerSpaces[0].customDomain
    ) {
      customDomain = ownerSpaces[0].customDomain;
      // Handle domainVerified which could be a Date or boolean
      if (ownerSpaces[0].domainVerified !== null) {
        domainVerified = true; // If it exists (not null), consider it verified
      }
    }
  }

  // Get space members if the video is shared with a space
  const membersList = video.sharedSpace?.spaceId
    ? await db
        .select({
          userId: spaceMembers.userId,
        })
        .from(spaceMembers)
        .where(eq(spaceMembers.spaceId, video.sharedSpace.spaceId))
    : [];

  const videoWithSpaceInfo: VideoWithSpace = {
    ...video,
    spaceMembers: membersList.map((member) => member.userId),
    spaceId: video.sharedSpace?.spaceId ?? undefined,
  };

  return (
    <Share
      data={videoWithSpaceInfo}
      user={user}
      comments={commentsQuery}
      individualFiles={[]} // individualFiles}
      initialAnalytics={initialAnalytics}
      customDomain={customDomain}
      domainVerified={domainVerified}
    />
  );
}
