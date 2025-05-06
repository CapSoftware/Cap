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

  console.log("Debug - Checking access:", { userId, id });

  // Check if the ID belongs to a space
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

  // Check if the ID belongs to an organization if no space was found
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

  // If neither a space nor an organization was found, return 404
  if (spaceData.length === 0 && organizationData.length === 0) {
    console.log("Debug - Neither space nor organization found with ID:", id);
    notFound();
  }

  const isSpace = spaceData.length > 0;

  console.log(`Debug - Found ${isSpace ? "space" : "organization"}`);

  // Check user's access rights
  if (isSpace) {
    const space = spaceData[0] as SpaceData;
    const isSpaceCreator = space.createdById === userId;

    if (!isSpaceCreator) {
      // Check if user is a member of this space
      const spaceMembership = await db()
        .select({ id: spaceMembers.id })
        .from(spaceMembers)
        .where(
          and(eq(spaceMembers.userId, userId), eq(spaceMembers.spaceId, id))
        )
        .limit(1);

      // If not a space member, check if user is a member of the parent organization
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
  } else {
    const organization = organizationData[0] as OrganizationData;
    const isOrgOwner = organization.ownerId === userId;

    if (!isOrgOwner) {
      // Check if user is a member of this organization
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
        console.log("Debug - User has no access to this organization");
        notFound();
      }
    }
  }

  const offset = (page - 1) * limit;

  // Fetch the appropriate videos based on whether it's a space or an organization
  if (isSpace) {
    // Fetch videos for space
    const totalCountResult = await db()
      .select({ count: count() })
      .from(spaceVideos)
      .where(eq(spaceVideos.spaceId, id));

    const totalCount = totalCountResult[0]?.count || 0;

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

    // Process the data to clean it up and remove the temporary effectiveDate field
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

    console.log("spaceVideoData:", processedVideoData);

    return (
      <SharedCaps
        data={processedVideoData}
        count={totalCount}
        activeOrganizationId={id}
      />
    );
  } else {
    // Fetch videos for organization
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

    // Process the data to clean it up and remove the temporary effectiveDate field
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

    console.log("sharedVideoData:", processedVideoData);

    return (
      <SharedCaps
        data={processedVideoData}
        count={totalCount}
        activeOrganizationId={id}
      />
    );
  }
}
