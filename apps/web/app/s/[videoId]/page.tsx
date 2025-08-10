import { db } from "@cap/database";
import { eq, InferSelectModel } from "drizzle-orm";
import { Logo } from "@cap/ui";

import {
  videos,
  comments,
  users,
  sharedVideos,
  organizationMembers,
  organizations,
} from "@cap/database/schema";
import { VideoMetadata } from "@cap/database/types";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildEnv } from "@cap/env";
import { getVideoAnalytics } from "@/actions/videos/get-analytics";
import { transcribeVideo } from "@/lib/transcribe";
import { headers } from "next/headers";
import { generateAiMetadata } from "@/actions/videos/generate-ai-metadata";
import { isAiGenerationEnabled } from "@/utils/flags";

import { Share } from "./Share";
import { PasswordOverlay } from "./_components/PasswordOverlay";
import { ShareHeader } from "./_components/ShareHeader";
import { userHasAccessToVideo } from "@/utils/auth";

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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
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

  const headersList = headers();
  const referrer = headersList.get("x-referrer") || "";

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
          `/s/${videoId}`,
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
    robots: robotsDirective,
  };
}

export default async function ShareVideoPage(props: Props) {
  const params = props.params;
  const videoId = params.videoId as string;
  console.log("[ShareVideoPage] Starting page load for videoId:", videoId);

  const userPromise = getCurrentUser();

  const [video] = await db()
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
    .where(eq(videos.id, videoId));

  if (!video) {
    console.log("[ShareVideoPage] No video found for videoId:", videoId);
    return <p>No video found</p>;
  }

  const userAccess = await userHasAccessToVideo(userPromise, video);

  if (userAccess === "private") return <p>This video is private</p>;

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F8FA]">
      <PasswordOverlay
        isOpen={userAccess === "needs-password"}
        videoId={video.id}
      />
      {userAccess === "has-access" && (
        <AuthorizedContent video={video} user={userPromise} />
      )}
    </div>
  );
}

async function AuthorizedContent({
  video,
  user: _user,
}: {
  video: InferSelectModel<typeof videos> & {
    sharedOrganization: { organizationId: string } | null;
  };
  user: MaybePromise<InferSelectModel<typeof users> | null>;
}) {
  const user = await _user;
  const videoId = video.id;
  const userId = user?.id;

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
        console.log(
          "[ShareVideoPage] Access denied - domain restriction:",
          organization[0].allowedEmailDomain
        );
        return (
          <div className="flex flex-col justify-center items-center p-4 min-h-screen text-center">
            <h1 className="mb-4 text-2xl font-bold">Access Restricted</h1>
            <p className="mb-2 text-gray-10">
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

  const customDomainPromise = (async () => {
    if (!user) {
      return { customDomain: null, domainVerified: false };
    }
    const activeOrganizationId = user.activeOrganizationId;
    if (!activeOrganizationId) {
      return { customDomain: null, domainVerified: false };
    }

    // Fetch the active org
    const orgArr = await db()
      .select({
        customDomain: organizations.customDomain,
        domainVerified: organizations.domainVerified,
      })
      .from(organizations)
      .where(eq(organizations.id, activeOrganizationId))
      .limit(1);

    const org = orgArr[0];
    if (
      org &&
      org.customDomain &&
      org.domainVerified !== null &&
      user.id === video.ownerId
    ) {
      return { customDomain: org.customDomain, domainVerified: true };
    }
    return { customDomain: null, domainVerified: false };
  })();

  const sharedOrganizationsPromise = db()
    .select({ id: sharedVideos.organizationId, name: organizations.name })
    .from(sharedVideos)
    .innerJoin(organizations, eq(sharedVideos.organizationId, organizations.id))
    .where(eq(sharedVideos.videoId, videoId));

  const userOrganizationsPromise = (async () => {
    if (!userId) return [];

    const [ownedOrganizations, memberOrganizations] = await Promise.all([
      db()
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.ownerId, userId)),
      db()
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .innerJoin(
          organizationMembers,
          eq(organizations.id, organizationMembers.organizationId)
        )
        .where(eq(organizationMembers.userId, userId)),
    ]);

    const allOrganizations = [...ownedOrganizations, ...memberOrganizations];
    const uniqueOrganizationIds = new Set();

    return allOrganizations.filter((organization) => {
      if (uniqueOrganizationIds.has(organization.id)) return false;
      uniqueOrganizationIds.add(organization.id);
      return true;
    });
  })();

  const membersListPromise = video.sharedOrganization?.organizationId
    ? db()
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          eq(
            organizationMembers.organizationId,
            video.sharedOrganization.organizationId
          )
        )
    : Promise.resolve([]);

  const commentsPromise = db()
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
    .where(eq(comments.videoId, videoId))
    .execute();

  const viewsPromise = getVideoAnalytics(videoId).then((v) => v.count);

  const [
    membersList,
    userOrganizations,
    sharedOrganizations,
    { customDomain, domainVerified },
  ] = await Promise.all([
    membersListPromise,
    userOrganizationsPromise,
    sharedOrganizationsPromise,
    customDomainPromise,
  ]);

  const videoWithOrganizationInfo: VideoWithOrganization = {
    ...video,
    organizationMembers: membersList.map((member) => member.userId),
    organizationId: video.sharedOrganization?.organizationId ?? undefined,
    sharedOrganizations: sharedOrganizations,
    password: null,
    hasPassword: video.password !== null,
  };

  return (
    <>
      <div className="container flex-1 px-4 py-4 mx-auto">
        <ShareHeader
          data={{
            ...videoWithOrganizationInfo,
            createdAt: video.metadata?.customCreatedAt
              ? new Date(video.metadata.customCreatedAt)
              : video.createdAt,
          }}
          user={user}
          customDomain={customDomain}
          domainVerified={domainVerified}
          sharedOrganizations={
            videoWithOrganizationInfo.sharedOrganizations || []
          }
          userOrganizations={userOrganizations}
          NODE_ENV={process.env.NODE_ENV}
        />

        <Share
          data={videoWithOrganizationInfo}
          user={user}
          comments={commentsPromise}
          views={viewsPromise}
          customDomain={customDomain}
          domainVerified={domainVerified}
          userOrganizations={userOrganizations}
          initialAiData={initialAiData}
          aiGenerationEnabled={aiGenerationEnabled}
        />
      </div>
      <div className="py-4 mt-auto">
        <a
          target="_blank"
          href={`/?ref=video_${video.id}`}
          className="flex justify-center items-center px-4 py-2 mx-auto space-x-2 rounded-full bg-gray-1 new-card-style w-fit"
        >
          <span className="text-sm">Recorded with</span>
          <Logo className="w-14 h-auto" />
        </a>
      </div>
    </>
  );
}
