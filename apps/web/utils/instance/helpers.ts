import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaceInvites, spaceMembers, users } from "@cap/database/schema";
import { count, eq } from "drizzle-orm";

// get the total number of users on the server
export const getServerUserCount = async () => {
  const userCount = await db.select({ count: count() }).from(users);
  const inviteCount = await db.select({ count: count() }).from(spaceInvites);
  return (userCount[0]?.count || 0) + (inviteCount[0]?.count || 0);
};

// get the number of users on a workspace (including invites)
export const getCloudWorkspaceUserCount = async ({
  workspaceId,
}: {
  workspaceId: string;
}) => {
  const userCount = await db
    .select({ count: count() })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, workspaceId));
  const inviteCount = await db
    .select({ count: count() })
    .from(spaceInvites)
    .where(eq(spaceInvites.spaceId, workspaceId));
  return (userCount[0]?.count || 0) + (inviteCount[0]?.count || 0);
};

// get all workspace IDs the user is a member of
export const getUserWorkspaceMembershipWorkspaceIds = async () => {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("Not authorized");
  }

  const userWorkspaceMemberships = await db.query.spaceMembers.findMany({
    where: eq(spaceMembers.userId, currentUser.id),
    columns: {
      id: true,
      spaceId: true,
    },
    with: {
      space: {
        columns: {
          id: true,
        },
      },
    },
  });

  const workspaceMembershipsWorkspaceIds = userWorkspaceMemberships.map(
    (membership) => membership.space.id
  );

  return workspaceMembershipsWorkspaceIds;
};
