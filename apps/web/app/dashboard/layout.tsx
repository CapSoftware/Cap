import DynamicSharedLayout from "@/app/dashboard/_components/DynamicSharedLayout";
import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";
import { DashboardTemplate } from "@/components/templates/DashboardTemplate";
import { db } from "@cap/database";
import {
  spaceMembers,
  spaces,
  spaceInvites,
  users,
} from "@cap/database/schema";
import { eq, inArray, or, and, count, sql } from "drizzle-orm";

export type Space = {
  space: typeof spaces.$inferSelect;
  members: (typeof spaceMembers.$inferSelect & {
    user: Pick<typeof users.$inferSelect, "id" | "name" | "email" | "lastName">;
  })[];
  invites: (typeof spaceInvites.$inferSelect)[];
  inviteQuota: number;
  totalInvites: number;
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user || !user.id) {
    redirect("/login");
  }

  const spacesWithMembers = await db
    .select({
      space: spaces,
      member: spaceMembers,
      user: {
        id: users.id,
        name: users.name,
        lastName: users.lastName,
        email: users.email,
        inviteQuota: users.inviteQuota,
      },
    })
    .from(spaces)
    .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
    .leftJoin(users, eq(spaceMembers.userId, users.id))
    .where(or(eq(spaces.ownerId, user.id), eq(spaceMembers.userId, user.id)));

  const spaceIds = spacesWithMembers.map((row) => row.space.id);

  let spaceInvitesData: (typeof spaceInvites.$inferSelect)[] = [];
  if (spaceIds.length > 0) {
    spaceInvitesData = await db
      .select()
      .from(spaceInvites)
      .where(inArray(spaceInvites.spaceId, spaceIds));
  }

  const spaceSelect: Space[] = await Promise.all(
    spacesWithMembers
      .reduce((acc: (typeof spaces.$inferSelect)[], row) => {
        const existingSpace = acc.find((s) => s.id === row.space.id);
        if (!existingSpace) {
          acc.push(row.space);
        }
        return acc;
      }, [])
      .map(async (space) => {
        const allMembers = await db
          .select({
            member: spaceMembers,
            user: {
              id: users.id,
              name: users.name,
              lastName: users.lastName,
              email: users.email,
            },
          })
          .from(spaceMembers)
          .leftJoin(users, eq(spaceMembers.userId, users.id))
          .where(eq(spaceMembers.spaceId, space.id));

        const owner = await db
          .select({
            inviteQuota: users.inviteQuota,
          })
          .from(users)
          .where(eq(users.id, space.ownerId))
          .then((result) => result[0]);

        const totalInvitesResult = await db
          .select({
            value: sql<number>`
              ${count(spaceMembers.id)} + ${count(spaceInvites.id)}
            `,
          })
          .from(spaces)
          .leftJoin(spaceMembers, eq(spaces.id, spaceMembers.spaceId))
          .leftJoin(spaceInvites, eq(spaces.id, spaceInvites.spaceId))
          .where(eq(spaces.ownerId, space.ownerId));

        const totalInvites = totalInvitesResult[0]?.value || 0;

        return {
          space,
          members: allMembers.map((m) => ({ ...m.member, user: m.user! })),
          invites: spaceInvitesData.filter(
            (invite) => invite.spaceId === space.id
          ),
          inviteQuota: owner?.inviteQuota || 1,
          totalInvites,
        };
      })
  );

  let findActiveSpace = spaceSelect.find(
    (space) => space.space.id === user.activeSpaceId
  );

  if (!findActiveSpace && spaceSelect.length > 0) {
    findActiveSpace = spaceSelect[0];
  }

  console.log("spaceSelect", spaceSelect);
  console.log("findActiveSpace", findActiveSpace);

  return (
    <DynamicSharedLayout
      spaceData={spaceSelect}
      activeSpace={findActiveSpace || null}
      user={user}
    >
      <div className="full-layout">
        <DashboardTemplate>{children}</DashboardTemplate>
      </div>
    </DynamicSharedLayout>
  );
}
