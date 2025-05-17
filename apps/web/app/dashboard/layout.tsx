import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
  organizationInvites,
  organizationMembers,
  organizations,
  users,
  spaces,
} from "@cap/database/schema";
import { count, eq, inArray, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type Organization = {
  organization: typeof organizations.$inferSelect;
  members: (typeof organizationMembers.$inferSelect & {
    user: Pick<typeof users.$inferSelect, "id" | "name" | "email" | "lastName">;
  })[];
  invites: (typeof organizationInvites.$inferSelect)[];
  inviteQuota: number;
  totalInvites: number;
};

export type Space = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string;
};

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user || !user.id) {
    redirect("/login");
  }

  if (!user.name || user.name.length <= 1) {
    redirect("/onboarding");
  }

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

  let organizationInvitesData: (typeof organizationInvites.$inferSelect)[] = [];
  if (organizationIds.length > 0) {
    organizationInvitesData = await db()
      .select()
      .from(organizationInvites)
      .where(inArray(organizationInvites.organizationId, organizationIds));
  }

  // Fetch spaces for the user's organizations
  let spacesData: Space[] = [];
  if (organizationIds.length > 0) {
    spacesData = await db()
      .select({
        id: spaces.id,
        name: spaces.name,
        description: spaces.description,
        organizationId: spaces.organizationId,
      })
      .from(spaces)
      .where(inArray(spaces.organizationId, organizationIds));
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

  let findActiveOrganization = organizationSelect.find(
    (organization) => organization.organization.id === user.activeOrganizationId
  );

  if (!findActiveOrganization && organizationSelect.length > 0) {
    findActiveOrganization = organizationSelect[0];
  }

  const isSubscribed =
    (user.stripeSubscriptionId &&
      user.stripeSubscriptionStatus !== "cancelled") ||
    !!user.thirdPartyStripeSubscriptionId;

  const theme = cookies().get("theme")?.value ?? "light";
  const sidebar = cookies().get("sidebarCollapsed")?.value ?? "false";

  return (
    <DynamicSharedLayout
      organizationData={organizationSelect}
      activeOrganization={findActiveOrganization || null}
      spacesData={spacesData}
      user={user}
      isSubscribed={isSubscribed}
      initialTheme={theme as "light" | "dark"}
      initialSidebarCollapsed={sidebar === "true"}
    >
      <DashboardTemplate>{children}</DashboardTemplate>
    </DynamicSharedLayout>
  );
}
