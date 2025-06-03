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
import { VideoMetadata } from "@cap/database/types";
import { getCurrentUser, userSelectProps } from "@cap/database/auth/session";
import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { ImageViewer } from "./_components/ImageViewer";
import { buildEnv } from "@cap/env";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { transcribeVideo } from "@/actions/videos/transcribe";
import { getScreenshot } from "@/actions/screenshots/get-screenshot";
import { cookies, headers } from "next/headers";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { isAiGenerationEnabled, isAiUiEnabled } from "@/utils/flags";
import { PasswordOverlay } from "./_components/PasswordOverlay";
import { decrypt } from "@cap/database/crypto";

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
  password?: string | null;
  hasPassword?: boolean;
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

  // Get the headers from the middleware
  const headersList = headers();
  const referrer = headersList.get("x-referrer") || "";

  // Check if referrer is from allowed platforms
  const allowedReferrers = [
    "x.com",
    "twitter.com",
    "facebook.com",
    "fb.com",
    "slack.com",
    "notion.so",
    "linkedin.com",
  ];

  const isAllowedReferrer = allowedReferrers.some((domain) =>
    referrer.includes(domain)
  );

  // Set robots metadata based on referrer and video publicity
  const robotsDirective = isAllowedReferrer
    ? "index, follow"
    : "noindex, nofollow";

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
              `/api/playlist?userId=${video.ownerId}&videoId=${video.id}`,
              buildEnv.NEXT_PUBLIC_WEB_URL
            ).toString(),
            width: 1280,
            height: 720,
            type: "video/mp4",
          },
        ],
      },
      robots: "noindex, nofollow",
    };
  }

  if (video.password !== null) {
    return {
      title: "Cap: Password Protected Video",
      description: "This video is password protected.",
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
      },
      twitter: {
        card: "summary_large_image",
        title: "Cap: Password Protected Video",
        description: "This video is password protected.",
        images: [
          new URL(
            `/api/video/og?videoId=${videoId}`,
            buildEnv.NEXT_PUBLIC_WEB_URL
          ).toString(),
        ],
      },
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
    robots: robotsDirective,
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
    console.log("[ShareVideoPage] No video found for videoId:", videoId);
    return <p>No video found</p>;
  }

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
    aiGenerationEnabled = isAiGenerationEnabled(videoOwner);
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
          <div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
            <h1 className="mb-4 text-2xl font-bold">Access Restricted</h1>
            <p className="mb-2 text-gray-600">
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

  if (
    video.transcriptionStatus !== "COMPLETE" &&
    video.transcriptionStatus !== "PROCESSING"
  ) {
    console.log("[ShareVideoPage] Starting transcription for video:", videoId);
    await transcribeVideo(videoId, video.ownerId, aiGenerationEnabled);

    const updatedVideoQuery = await db()
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

    if (updatedVideoQuery[0]) {
      Object.assign(video, updatedVideoQuery[0]);
      console.log(
        "[ShareVideoPage] Updated transcription status:",
        video.transcriptionStatus
      );
    }
  }

  const currentMetadata = (video.metadata as VideoMetadata) || {};
  const metadata = currentMetadata;
  let initialAiData = null;

  if (metadata.summary || metadata.chapters || metadata.aiTitle) {
    initialAiData = {
      title: metadata.aiTitle || null,
      summary: metadata.summary || null,
      chapters: metadata.chapters || null,
      processing: metadata.aiProcessing || false,
    };
  } else if (metadata.aiProcessing) {
    initialAiData = {
      title: null,
      summary: null,
      chapters: null,
      processing: true,
    };
  }

  if (
    video.transcriptionStatus === "COMPLETE" &&
    !currentMetadata.aiProcessing &&
    !currentMetadata.summary &&
    !currentMetadata.chapters &&
    !currentMetadata.generationError &&
    aiGenerationEnabled
  ) {
    try {
      generateAiMetadata(videoId, video.ownerId).catch((error) => {
        console.error(
          `[ShareVideoPage] Error generating AI metadata for video ${videoId}:`,
          error
        );
      });
    } catch (error) {
      console.error(
        `[ShareVideoPage] Error starting AI metadata generation for video ${videoId}:`,
        error
      );
    }
  }

  if (video.public === false && userId !== video.ownerId) {
    return <p>This video is private</p>;
  }

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
    password: null,
    hasPassword: video.password !== null,
  };

  let aiUiEnabled = false;
  if (user?.email) {
    aiUiEnabled = isAiUiEnabled({
      email: user.email,
      stripeSubscriptionStatus: user.stripeSubscriptionStatus,
    });
    console.log(
      `[ShareVideoPage] AI UI feature flag check for viewer ${user.id}: ${aiUiEnabled} (email: ${user.email})`
    );
  }

  const authorized =
    !videoWithOrganizationInfo.hasPassword ||
    user?.id === videoWithOrganizationInfo.ownerId ||
    (await verifyPasswordCookie(video.password ?? ""));

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA]">
      <PasswordOverlay
        isOpen={!authorized}
        videoId={videoWithOrganizationInfo.id}
      />
      {authorized && (
        <Share
          data={videoWithOrganizationInfo}
          user={user}
          comments={commentsQuery}
          initialAnalytics={initialAnalytics}
          customDomain={customDomain}
          domainVerified={domainVerified}
          userOrganizations={userOrganizations}
          initialAiData={initialAiData}
          aiGenerationEnabled={aiGenerationEnabled}
          aiUiEnabled={aiUiEnabled}
        />
      )}
    </div>
  );
}

async function verifyPasswordCookie(videoPassword: string) {
  const password = cookies().get("x-cap-password")?.value;
  if (!password) return false;

  const decrypted = await decrypt(password).catch(() => "");
  return decrypted === videoPassword;
}
