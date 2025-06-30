import { db } from "@cap/database";
import { userSelectProps } from "@cap/database/auth/session";
import {
  organizationInvites,
  organizationMembers,
  organizations,
  users,
  spaces,
  sharedVideos,
  spaceMembers,
} from "@cap/database/schema";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";

export type Organization = {
  organization: typeof organizations.$inferSelect;
  members: (typeof organizationMembers.$inferSelect & {
    user: Pick<
      typeof users.$inferSelect,
      "id" | "name" | "email" | "lastName" | "image"
    >;
  })[];
  invites: (typeof organizationInvites.$inferSelect)[];
  inviteQuota: number;
  totalInvites: number;
};

export type Spaces = Omit<
  typeof spaces.$inferSelect,
  "createdAt" | "updatedAt"
> & {
  memberCount: number;
  videoCount: number;
};

export async function getDashboardData(user: typeof userSelectProps) {
  try {
    const organizationsWithMembers = await db()
      .select({
        organization: organizations,
        member: organizationMembers,
        user: {
          id: users.id,
          name: users.name,
          lastName: users.lastName,
          email: users.email,
          inviteQuota: users.inviteQuota,
          image: users.image,
        },
      })
      .from(organizations)
      .leftJoin(
        organizationMembers,
        eq(organizations.id, organizationMembers.organizationId)
      )
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        or(
          eq(organizations.ownerId, user.id),
          eq(organizationMembers.userId, user.id)
        )
      );

    const organizationIds = organizationsWithMembers.map(
      (row) => row.organization.id
    );

    let organizationInvitesData: (typeof organizationInvites.$inferSelect)[] =
      [];
    if (organizationIds.length > 0) {
      organizationInvitesData = await db()
        .select()
        .from(organizationInvites)
        .where(inArray(organizationInvites.organizationId, organizationIds));
    }

    let spacesData: Spaces[] = [];

    // Find active organization ID

    let activeOrganizationId = organizationIds.find(
      (orgId) => orgId === user.activeOrganizationId
    );

    if (!activeOrganizationId && organizationIds.length > 0) {
      activeOrganizationId = organizationIds[0];
    }
    // Only fetch spaces for the active organization

    if (activeOrganizationId) {
      spacesData = await db()
        .select({
          id: spaces.id,
          primary: spaces.primary,
          privacy: spaces.privacy,
          name: spaces.name,
          description: spaces.description,
          organizationId: spaces.organizationId,
          createdById: spaces.createdById,
          iconUrl: spaces.iconUrl,
          memberCount: sql<number>`(
            SELECT COUNT(*) FROM space_members WHERE space_members.spaceId = spaces.id
          )`,
          videoCount: sql<number>`(
            SELECT COUNT(*) FROM space_videos WHERE space_videos.spaceId = spaces.id
          )`,
        })
        .from(spaces)
        .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
        .where(
          and(
            eq(spaces.organizationId, activeOrganizationId),
            or(
              // User is the space creator
              eq(spaces.createdById, user.id),
              // User is a member of the space
              eq(spaceMembers.userId, user.id),
              // Space is public within the organization
              eq(spaces.privacy, "Public")
            )
          )
        )
        .groupBy(spaces.id);

      // Add a single 'All spaces' entry for the active organization
      const activeOrgInfo = organizationsWithMembers.find(
        (row) => row.organization.id === activeOrganizationId
      );
      if (activeOrgInfo) {
        // Count all members in the organization
        const orgMemberCountResult = await db()
          .select({ value: sql<number>`COUNT(*)` })
          .from(organizationMembers)
          .where(
            eq(
              organizationMembers.organizationId,
              activeOrgInfo.organization.id
            )
          );
        const orgMemberCount = orgMemberCountResult[0]?.value || 0;

        // Count all videos shared with the organization (via sharedVideos table)
        const orgVideoCountResult = await db()
          .select({
            value: sql<number>`COUNT(DISTINCT ${sharedVideos.videoId})`,
          })
          .from(sharedVideos)
          .where(
            eq(sharedVideos.organizationId, activeOrgInfo.organization.id)
          );
        const orgVideoCount = orgVideoCountResult[0]?.value || 0;

        const allSpacesEntry = {
          id: activeOrgInfo.organization.id,
          primary: true,
          privacy: "Public",
          name: `All ${activeOrgInfo.organization.name}`,
          description: `View all content in ${activeOrgInfo.organization.name}`,
          organizationId: activeOrgInfo.organization.id,
          iconUrl: null,
          memberCount: orgMemberCount,
          createdById: activeOrgInfo.organization.ownerId,
          videoCount: orgVideoCount,
        } as const;
        spacesData = [allSpacesEntry, ...spacesData];
      }
    }

    const organizationSelect: Organization[] = await Promise.all(
      organizationsWithMembers
        .reduce((acc: (typeof organizations.$inferSelect)[], row) => {
          const existingOrganization = acc.find(
            (o) => o.id === row.organization.id
          );
          if (!existingOrganization) {
            acc.push(row.organization);
          }
          return acc;
        }, [])
        .map(async (organization) => {
          const allMembers = await db()
            .select({
              member: organizationMembers,
              user: {
                id: users.id,
                name: users.name,
                lastName: users.lastName,
                email: users.email,
                image: users.image,
              },
            })
            .from(organizationMembers)
            .leftJoin(users, eq(organizationMembers.userId, users.id))
            .where(eq(organizationMembers.organizationId, organization.id));

          const owner = await db()
            .select({
              inviteQuota: users.inviteQuota,
            })
            .from(users)
            .where(eq(users.id, organization.ownerId))
            .then((result) => result[0]);

          const totalInvitesResult = await db()
            .select({
              value: sql<number>`
                ${count(organizationMembers.id)} + ${count(
                organizationInvites.id
              )}
              `,
            })
            .from(organizations)
            .leftJoin(
              organizationMembers,
              eq(organizations.id, organizationMembers.organizationId)
            )
            .leftJoin(
              organizationInvites,
              eq(organizations.id, organizationInvites.organizationId)
            )
            .where(eq(organizations.ownerId, organization.ownerId));

          const totalInvites = totalInvitesResult[0]?.value || 0;

          return {
            organization,
            members: allMembers.map((m) => ({ ...m.member, user: m.user! })),
            invites: organizationInvitesData.filter(
              (invite) => invite.organizationId === organization.id
            ),
            inviteQuota: owner?.inviteQuota || 1,
            totalInvites,
          };
        })
    );

    return {
      organizationSelect,
      spacesData,
    };
  } catch (error) {
    console.error("Failed to fetch dashboard data", error);
    return {
      organizationSelect: [],
      spacesData: [],
    };
  }
}
