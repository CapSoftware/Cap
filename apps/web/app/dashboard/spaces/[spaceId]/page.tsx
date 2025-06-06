import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  comments,
  sharedVideos,
  organizationMembers,
  organizations,
  users,
  videos,
  spaces,
  spaceMembers,
  spaceVideos,
} from "@cap/database/schema";
import { count, desc, eq, sql, and, isNull } from "drizzle-orm";
import { Metadata } from "next";
import { SharedCaps } from "./SharedCaps";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Shared Caps — Cap",
};

export const revalidate = 0;

type SpaceData = {
  id: string;
  name: string;
  organizationId: string;
  createdById: string;
};

type OrganizationData = {
  id: string;
  name: string;
  ownerId: string;
};

type SpaceMemberData = {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string;
};

export default async function SharedCapsPage({
  params,
  searchParams,
}: {
  params: { spaceId: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const page = Number(searchParams.page) || 1;
  const limit = Number(searchParams.limit) || 15;
  const user = await getCurrentUser();
  const userId = user?.id as string;
  const id = params.spaceId;

  const spaceData = await db()
    .select({
      id: spaces.id,
      name: spaces.name,
      organizationId: spaces.organizationId,
      createdById: spaces.createdById,
    })
    .from(spaces)
    .where(eq(spaces.id, id))
    .limit(1);

  const organizationData =
    spaceData.length === 0
      ? await db()
          .select({
            id: organizations.id,
            name: organizations.name,
            ownerId: organizations.ownerId,
          })
          .from(organizations)
          .where(eq(organizations.id, id))
          .limit(1)
      : [];

  if (spaceData.length === 0 && organizationData.length === 0) {
    console.log("Debug - Neither space nor organization found with ID:", id);
    notFound();
  }

  const isSpace = spaceData.length > 0;

  console.log(`Debug - Found ${isSpace ? "space" : "organization"}`);

  if (isSpace) {
    const space = spaceData[0] as SpaceData;
    const isSpaceCreator = space.createdById === userId;

    if (!isSpaceCreator) {
      const spaceMembership = await db()
        .select({ id: spaceMembers.id })
        .from(spaceMembers)
        .where(
          and(eq(spaceMembers.userId, userId), eq(spaceMembers.spaceId, id))
        )
        .limit(1);

      if (spaceMembership.length === 0) {
        const orgMembership = await db()
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, userId),
              eq(organizationMembers.organizationId, space.organizationId)
            )
          )
          .limit(1);

        if (orgMembership.length === 0) {
          console.log("Debug - User has no access to this space");
          notFound();
        }
      }
    }

    // Fetch space members data with user details
    const spaceMembersData = await db()
      .select({
        id: spaceMembers.id,
        userId: spaceMembers.userId,
        role: spaceMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.userId, users.id))
      .where(eq(spaceMembers.spaceId, id));

    // Fetch organization members for adding to space
    const organizationMembersData = await db()
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.organizationId, space.organizationId));
  } else {
    const organization = organizationData[0] as OrganizationData;
    const isOrgOwner = organization.ownerId === userId;

    if (!isOrgOwner) {
      const orgMembership = await db()
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.organizationId, id)
          )
        )
        .limit(1);

      if (orgMembership.length === 0) {
        notFound();
      }
    }
  }

  const offset = (page - 1) * limit;

  if (isSpace) {
    const space = spaceData[0] as SpaceData;
    const totalCountResult = await db()
      .select({ count: count() })
      .from(spaceVideos)
      .where(eq(spaceVideos.spaceId, id));

    const totalCount = totalCountResult[0]?.count || 0;

    // Fetch space members data with user details
    const spaceMembersData = await db()
      .select({
        id: spaceMembers.id,
        userId: spaceMembers.userId,
        role: spaceMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(spaceMembers.userId, users.id))
      .where(eq(spaceMembers.spaceId, id));

    // Fetch organization members for adding to space
    const organizationMembersData = await db()
      .select({
        id: organizationMembers.id,
        userId: organizationMembers.userId,
        role: organizationMembers.role,
        name: users.name,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(eq(organizationMembers.organizationId, space.organizationId));

    const spaceVideoData = await db()
      .select({
        id: videos.id,
        ownerId: videos.ownerId,
        name: videos.name,
        createdAt: videos.createdAt,
        metadata: videos.metadata,
        totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
        totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
        ownerName: users.name,
        effectiveDate: sql<string>`
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
            ${videos.createdAt}
          )
        `,
      })
      .from(spaceVideos)
      .innerJoin(videos, eq(spaceVideos.videoId, videos.id))
      .leftJoin(comments, eq(videos.id, comments.videoId))
      .leftJoin(users, eq(videos.ownerId, users.id))
      .where(eq(spaceVideos.spaceId, id))
      .groupBy(
        videos.id,
        videos.ownerId,
        videos.name,
        videos.createdAt,
        videos.metadata,
        users.name
      )
      .orderBy(
        desc(sql`COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )`)
      )
      .limit(limit)
      .offset(offset);

    const processedVideoData = spaceVideoData.map((video) => {
      const { effectiveDate, ...videoWithoutEffectiveDate } = video;

      return {
        ...videoWithoutEffectiveDate,
        ownerName: video.ownerName ?? null,
        metadata: video.metadata as
          | {
              customCreatedAt?: string;
              [key: string]: any;
            }
          | undefined,
      };
    });

    return (
      <SharedCaps
        data={processedVideoData}
        count={totalCount}
        spaceData={space}
        spaceMembers={spaceMembersData}
        organizationMembers={organizationMembersData}
        currentUserId={userId}
      />
    );
  } else {
    const totalCountResult = await db()
      .select({ count: count() })
      .from(sharedVideos)
      .where(eq(sharedVideos.organizationId, id));

    const totalCount = totalCountResult[0]?.count || 0;

    const sharedVideoData = await db()
      .select({
        id: videos.id,
        ownerId: videos.ownerId,
        name: videos.name,
        createdAt: videos.createdAt,
        metadata: videos.metadata,
        totalComments: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'text' THEN ${comments.id} END)`,
        totalReactions: sql<number>`COUNT(DISTINCT CASE WHEN ${comments.type} = 'emoji' THEN ${comments.id} END)`,
        ownerName: users.name,
        effectiveDate: sql<string>`
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
            ${videos.createdAt}
          )
        `,
      })
      .from(sharedVideos)
      .innerJoin(videos, eq(sharedVideos.videoId, videos.id))
      .leftJoin(comments, eq(videos.id, comments.videoId))
      .leftJoin(users, eq(videos.ownerId, users.id))
      .where(eq(sharedVideos.organizationId, id))
      .groupBy(
        videos.id,
        videos.ownerId,
        videos.name,
        videos.createdAt,
        videos.metadata,
        users.name
      )
      .orderBy(
        desc(sql`COALESCE(
          JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.customCreatedAt')),
          ${videos.createdAt}
        )`)
      )
      .limit(limit)
      .offset(offset);

    const processedVideoData = sharedVideoData.map((video) => {
      const { effectiveDate, ...videoWithoutEffectiveDate } = video;

      return {
        ...videoWithoutEffectiveDate,
        ownerName: video.ownerName ?? null,
        metadata: video.metadata as
          | {
              customCreatedAt?: string;
              [key: string]: any;
            }
          | undefined,
      };
    });

    return (
      <SharedCaps data={processedVideoData} count={totalCount} hideSharedWith />
    );
  }
}
