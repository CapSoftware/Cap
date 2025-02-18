import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverConfigTable, spaceMembers, users } from "@cap/database/schema";
import { count, eq } from "drizzle-orm";
import { getServerConfig } from "./functions";
import { INSTANCE_SITE_URL, LICENSE_SERVER_URL } from "./constants";

// get the total number of users on the server
export const getServerUserCount = async () => {
  const userCount = await db.select({ count: count() }).from(users);
  return userCount[0]?.count || 0;
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

export async function licenseApi({
  method,
  endpoint,
  body,
  serverConfig,
}: {
  method: "POST" | "GET";
  endpoint:
    | "instances/validate"
    | "instances/add-user"
    | "instances/user"
    | "instances/workspace"
    | "instances/workspace/add-user"
    | "instances/workspace/checkout"
    | "instances/workspace/portal";
  body: object;
  serverConfig: typeof serverConfigTable.$inferSelect;
}) {
  if (!serverConfig.licenseKey || !serverConfig.licenseValid) {
    throw new Error("Server does not have a valid license");
  }

  const licenseServerResponse = await fetch(
    `${LICENSE_SERVER_URL}/api/${endpoint}`,
    {
      method,
      headers: {
        licenseKey: serverConfig.licenseKey,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  return licenseServerResponse;
}
