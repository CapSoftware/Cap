import { db } from "@cap/database";
import { eq } from "drizzle-orm";
import {
  videos,
  users,
  sharedVideos,
  organizations,
  comments,
} from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { buildEnv } from "@cap/env";
import { transcribeVideo } from "@/lib/transcribe";
import { isAiGenerationEnabled } from "@/utils/flags";
import { userHasAccessToVideo } from "@/utils/auth";
import { EmbedVideo } from "./_components/EmbedVideo";
import { PasswordOverlay } from "./_components/PasswordOverlay";

export const dynamic = "auto";
export const dynamicParams = true;
export const revalidate = 30;

type Props = {
  params: { [key: string]: string | string[] | undefined };
  searchParams: { [key: string]: string | string[] | undefined };
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const videoId = params.videoId as string;
  const query = await db().select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    return notFound();
  }

  const video = query[0];

  if (!video) {
    return notFound();
  }

  const userPromise = getCurrentUser();
  const userAccess = await userHasAccessToVideo(userPromise, video);

  if (video.public === false && userAccess !== "has-access") {
    return {
      title: "Cap: This video is private",
      description: "This video is private and cannot be shared.",
      robots: "noindex, nofollow",
    };
  }

  if (video.password !== null && userAccess !== "has-access") {
    return {
      title: "Cap: Password Protected Video",
      description: "This video is password protected.",
      robots: "noindex, nofollow",
    };
  }

  return {
    title: video.name + " | Cap Recording",
    description: "Watch this video on Cap",
    openGraph: {
      images: [
        {
          url: new URL(
            `/api/video/og?videoId=${videoId}`,
            buildEnv.NEXT_PUBLIC_WEB_URL
          ).toString(),
          width: 1200,
          height: 630,
        },
      ],
      videos: [
        {
          url: new URL(
            `/api/playlist?userId=${video.ownerId}&videoId=${video.id}`,
            buildEnv.NEXT_PUBLIC_WEB_URL
          ).toString(),
          width: 1280,
          height: 720,
          type: "video/mp4",
        },
      ],
    },
    twitter: {
      card: "player",
      title: video.name + " | Cap Recording",
      description: "Watch this video on Cap",
      images: [
        new URL(
          `/api/video/og?videoId=${videoId}`,
          buildEnv.NEXT_PUBLIC_WEB_URL
        ).toString(),
      ],
      players: {
        playerUrl: new URL(
          `/embed/${videoId}`,
          buildEnv.NEXT_PUBLIC_WEB_URL
        ).toString(),
        streamUrl: new URL(
          `/api/playlist?userId=${video.ownerId}&videoId=${video.id}`,
          buildEnv.NEXT_PUBLIC_WEB_URL
        ).toString(),
        width: 1280,
        height: 720,
      },
    },
    robots: "index, follow",
  };
}

export default async function EmbedVideoPage(props: Props) {
  const params = props.params;
  const searchParams = props.searchParams;
  const videoId = params.videoId as string;
  const autoplay = searchParams.autoplay === "true";

  const user = await getCurrentUser();

  const videoWithOrganization = await db()
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
      password: videos.password,
      source: videos.source,
      sharedOrganization: {
        organizationId: sharedVideos.organizationId,
      },
    })
    .from(videos)
    .leftJoin(sharedVideos, eq(videos.id, sharedVideos.videoId))
    .where(eq(videos.id, videoId))
    .execute();

  const video = videoWithOrganization[0];

  if (!video) {
    return notFound();
  }

  const userAccess = await userHasAccessToVideo(user, video);

  if (userAccess === "private") {
    return (
      <div className="flex flex-col justify-center items-center min-h-screen text-center bg-black text-white">
        <h1 className="mb-4 text-2xl font-bold">This video is private</h1>
        <p className="text-gray-400">
          If you own this video, please <Link href="/login">sign in</Link> to manage sharing.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <PasswordOverlay
        isOpen={userAccess === "needs-password"}
        videoId={video.id}
      />
      {userAccess === "has-access" && (
        <EmbedContent video={video} user={user} autoplay={autoplay} />
      )}
    </div>
  );
}

async function EmbedContent({
  video,
  user,
  autoplay,
}: {
  video: typeof videos.$inferSelect & {
    sharedOrganization: { organizationId: string } | null;
  };
  user: typeof users.$inferSelect | null;
  autoplay: boolean;
}) {
  let aiGenerationEnabled = false;
  const videoOwnerQuery = await db()
    .select({
      email: users.email,
      stripeSubscriptionStatus: users.stripeSubscriptionStatus,
    })
    .from(users)
    .where(eq(users.id, video.ownerId))
    .limit(1);

  if (videoOwnerQuery.length > 0 && videoOwnerQuery[0]) {
    const videoOwner = videoOwnerQuery[0];
    aiGenerationEnabled = await isAiGenerationEnabled(videoOwner);
  }

  if (video.sharedOrganization?.organizationId) {
    const organization = await db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, video.sharedOrganization.organizationId))
      .limit(1);

    if (organization[0]?.allowedEmailDomain) {
      if (
        !user?.email ||
        !user.email.endsWith(`@${organization[0].allowedEmailDomain}`)
      ) {
        return (
          <div className="flex flex-col justify-center items-center min-h-screen text-center bg-black text-white">
            <h1 className="mb-4 text-2xl font-bold">Access Restricted</h1>
            <p className="mb-2 text-gray-300">
              This video is only accessible to members of this organization.
            </p>
            <p className="text-gray-400">
              Please sign in with your organization email address to access this
              content.
            </p>
          </div>
        );
      }
    }
  }

  if (
    video.transcriptionStatus !== "COMPLETE" &&
    video.transcriptionStatus !== "PROCESSING"
  ) {
    await transcribeVideo(video.id, video.ownerId, aiGenerationEnabled);
  }

  const currentMetadata = (video.metadata as VideoMetadata) || {};
  let initialAiData = null;

  if (
    currentMetadata.summary ||
    currentMetadata.chapters ||
    currentMetadata.aiTitle
  ) {
    initialAiData = {
      title: currentMetadata.aiTitle || null,
      summary: currentMetadata.summary || null,
      chapters: currentMetadata.chapters || null,
      processing: currentMetadata.aiProcessing || false,
    };
  } else if (currentMetadata.aiProcessing) {
    initialAiData = {
      title: null,
      summary: null,
      chapters: null,
      processing: true,
    };
  }

  if (video.isScreenshot === true) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-white">
        <p>Screenshots cannot be embedded</p>
      </div>
    );
  }

  const commentsQuery = await db()
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
    .where(eq(comments.videoId, video.id));

  const videoOwner = await db()
    .select({
      name: users.name,
    })
    .from(users)
    .where(eq(users.id, video.ownerId))
    .limit(1);

  return (
    <EmbedVideo
      data={video}
      user={user}
      comments={commentsQuery}
      chapters={initialAiData?.chapters || []}
      aiProcessing={initialAiData?.processing || false}
      ownerName={videoOwner[0]?.name || null}
      autoplay={autoplay}
    />
  );
}
