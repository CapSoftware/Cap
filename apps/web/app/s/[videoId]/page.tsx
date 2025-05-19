import { Share } from "./Share";
import { db } from "@cap/database";
import { eq, desc, sql, count } from "drizzle-orm";
import {
  videos,
  comments,
  users,
  sharedVideos,
  organizationMembers,
  organizations,
} from "@cap/database/schema";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";
import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { ImageViewer } from "./_components/ImageViewer";
import { buildEnv, serverEnv } from "@cap/env";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { transcribeVideo } from "@/actions/videos/transcribe";
import { getScreenshot } from "@/actions/screenshots/get-screenshot";

export const dynamic = "auto";
export const dynamicParams = true;
export const revalidate = 30;

type Props = {
  params: { [key: string]: string | string[] | undefined };
};

type CommentWithAuthor = typeof comments.$inferSelect & {
  authorName: string | null;
};

type VideoWithOrganization = typeof videos.$inferSelect & {
  sharedOrganization?: {
    organizationId: string;
  } | null;
  organizationMembers?: string[];
  organizationId?: string;
  sharedOrganizations?: { id: string; name: string }[];
};

type OrganizationMember = {
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
  const query = await db().select().from(videos).where(eq(videos.id, videoId));

  if (query.length === 0) {
    console.log("[generateMetadata] No video found for videoId:", videoId);
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
              `/s/${videoId}`,
              buildEnv.NEXT_PUBLIC_WEB_URL
            ).toString(),
            width: 1280,
            height: 720,
            type: "text/html",
          },
        ],
      },
      twitter: {
        card: "player",
        player: new URL(
          `/s/${videoId}`,
          buildEnv.NEXT_PUBLIC_WEB_URL
        ).toString(),
        playerWidth: 1280,
        playerHeight: 720,
      },
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
            `/s/${videoId}`,
            buildEnv.NEXT_PUBLIC_WEB_URL
          ).toString(),
          width: 1280,
          height: 720,
          type: "text/html",
        },
      ],
    },
    twitter: {
      card: "player",
      player: new URL(
        `/s/${videoId}`,
        buildEnv.NEXT_PUBLIC_WEB_URL
      ).toString(),
      playerWidth: 1280,
      playerHeight: 720,
      title: video.name + " | Cap Recording",
      description: "Watch this video on Cap",
      images: [
        new URL(
          `/api/video/og?videoId=${videoId}`,
          buildEnv.NEXT_PUBLIC_WEB_URL
        ).toString(),
      ],
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
    console.log("[ShareVideoPage] No video found for videoId:", videoId);
    return <p>No video found</p>;
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
        console.log(
          "[ShareVideoPage] Access denied - domain restriction:",
          organization[0].allowedEmailDomain
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

  if (video.transcriptionStatus !== "COMPLETE") {
    console.log("[ShareVideoPage] Starting transcription for video:", videoId);
    await transcribeVideo(videoId, video.ownerId);
  }

  if (video.public === false && userId !== video.ownerId) {
    console.log("[ShareVideoPage] Access denied - private video:", videoId);
    return <p>This video is private</p>;
  }

  console.log("[ShareVideoPage] Fetching comments for video:", videoId);
  const commentsQuery: CommentWithAuthor[] = await db()
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
    try {
      const data = await getScreenshot(video.ownerId, videoId);
      screenshotUrl = data.url;

      return (
        <ImageViewer
          imageSrc={screenshotUrl}
          data={video}
          user={user}
          comments={commentsQuery}
        />
      );
    } catch (error) {
      console.error("[ShareVideoPage] Error fetching screenshot:", error);
      return <p>Failed to load screenshot</p>;
    }
  }

  console.log("[ShareVideoPage] Fetching analytics for video:", videoId);
  const analyticsData = await getVideoAnalytics(videoId);

  const initialAnalytics = {
    views: analyticsData.count || 0,
    comments: commentsQuery.filter((c) => c.type === "text").length,
    reactions: commentsQuery.filter((c) => c.type === "emoji").length,
  };

  let customDomain: string | null = null;
  let domainVerified = false;

  if (video.sharedOrganization?.organizationId) {
    const organizationData = await db()
      .select({
        customDomain: organizations.customDomain,
        domainVerified: organizations.domainVerified,
      })
      .from(organizations)
      .where(eq(organizations.id, video.sharedOrganization.organizationId))
      .limit(1);

    if (
      organizationData.length > 0 &&
      organizationData[0] &&
      organizationData[0].customDomain
    ) {
      customDomain = organizationData[0].customDomain;
      if (organizationData[0].domainVerified !== null) {
        domainVerified = true;
      }
    }
  }

  if (!customDomain && video.ownerId) {
    const ownerOrganizations = await db()
      .select({
        customDomain: organizations.customDomain,
        domainVerified: organizations.domainVerified,
      })
      .from(organizations)
      .where(eq(organizations.ownerId, video.ownerId))
      .limit(1);

    if (
      ownerOrganizations.length > 0 &&
      ownerOrganizations[0] &&
      ownerOrganizations[0].customDomain
    ) {
      customDomain = ownerOrganizations[0].customDomain;
      if (ownerOrganizations[0].domainVerified !== null) {
        domainVerified = true;
      }
    }
  }

  const sharedOrganizationsData = await db()
    .select({
      id: sharedVideos.organizationId,
      name: organizations.name,
    })
    .from(sharedVideos)
    .innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
    .where(eq(sharedVideos.videoId, videoId));

  let userOrganizations: { id: string; name: string }[] = [];
  if (userId) {
    const ownedOrganizations = await db()
      .select({
        id: organizations.id,
        name: organizations.name,
      })
      .from(organizations)
      .where(eq(organizations.ownerId, userId));

    const memberOrganizations = await db()
      .select({
        id: organizations.id,
        name: organizations.name,
      })
      .from(organizations)
      .innerJoin(
        organizationMembers,
        eq(organizations.id, organizationMembers.organizationId)
      )
      .where(eq(organizationMembers.userId, userId));

    const allOrganizations = [...ownedOrganizations, ...memberOrganizations];
    const uniqueOrganizationIds = new Set();
    userOrganizations = allOrganizations.filter((organization) => {
      if (uniqueOrganizationIds.has(organization.id)) return false;
      uniqueOrganizationIds.add(organization.id);
      return true;
    });
  }

  const membersList = video.sharedOrganization?.organizationId
    ? await db()
        .select({
          userId: organizationMembers.userId,
        })
        .from(organizationMembers)
        .where(
          eq(
            organizationMembers.organizationId,
            video.sharedOrganization.organizationId
          )
        )
    : [];

  const videoWithOrganizationInfo: VideoWithOrganization = {
    ...video,
    organizationMembers: membersList.map((member) => member.userId),
    organizationId: video.sharedOrganization?.organizationId ?? undefined,
    sharedOrganizations: sharedOrganizationsData,
  };

  return (
    <Share
      data={videoWithOrganizationInfo}
      user={user}
      comments={commentsQuery}
      initialAnalytics={initialAnalytics}
      customDomain={customDomain}
      domainVerified={domainVerified}
      userOrganizations={userOrganizations}
    />
  );
}
