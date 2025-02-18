import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverConfigTable, spaces, users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { INSTANCE_SITE_URL, LICENSE_SERVER_URL } from "./constants";
import {
  getServerUserCount,
  getUserWorkspaceMembershipWorkspaceIds,
} from "./helpers";

export const getServerConfig = async (): Promise<
  typeof serverConfigTable.$inferSelect
> => {
  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  // create server config object if it doesn't exist
  if (!serverConfig) {
    const newServerConfig = {
      id: 1,
      licenseKey: null,
      licenseValid: false,
      isCapCloud: false,
      licenseValidityCache: null,
      superAdminIds: [],
      signupsEnabled: false,
      emailSendFromName: null,
      emailSendFromEmail: null,
    };
    await db.insert(serverConfigTable).values(newServerConfig);

    return newServerConfig;
  }

  if (
    serverConfig.licenseKey &&
    (serverConfig.licenseValidityCache === null ||
      serverConfig.licenseValidityCache.getTime() < Date.now())
  ) {
    const validationResult = await validateServerLicense({
      serverConfig,
    });
    return validationResult;
  }

  return serverConfig;
};

// check if the server is a Cap Cloud server
export const isCapCloud = async (): Promise<boolean> => {
  const serverConfig = await getServerConfig();
  return serverConfig.isCapCloud;
};

export const addServerSuperAdmin = async ({ userId }: { userId: string }) => {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("Not authorized");
  }

  const serverConfig = await getServerConfig();

  const existingSuperAdminIds = serverConfig.superAdminIds;

  if (
    existingSuperAdminIds.length > 0 &&
    !existingSuperAdminIds.includes(currentUser.id)
  ) {
    throw new Error("Not authorized");
  }

  // update server config superAdminIds array
  await db
    .update(serverConfigTable)
    .set({
      superAdminIds: [...existingSuperAdminIds, userId],
    })
    .where(eq(serverConfigTable.id, 1));
  return;
};

export async function validateServerLicense({
  serverConfig,
}: {
  serverConfig: typeof serverConfigTable.$inferSelect;
}): Promise<typeof serverConfigTable.$inferSelect> {
  if (!serverConfig?.licenseKey) {
    return serverConfig;
  }

  const licenseServerResponse = await fetch(
    `${LICENSE_SERVER_URL}/api/instances/validate`,
    {
      method: "POST",
      headers: {
        licenseKey: serverConfig.licenseKey,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        usedSeats: await getServerUserCount(),
      }),
    }
  );

  const licenseServerResponseCode = await licenseServerResponse.status;
  const licenseServerResponseJson = await licenseServerResponse.json();

  let newPartialServerConfig: Partial<
    typeof serverConfigTable.$inferInsert
  > | null = null;

  // handle 404, 403, 402, 409 : License not found, Too many seats, expired, already activated on another siteURL
  if (
    licenseServerResponseCode === 404 ||
    licenseServerResponseCode === 403 ||
    licenseServerResponseCode === 402 ||
    licenseServerResponseCode === 409
  ) {
    newPartialServerConfig = {
      licenseValid: false,
      licenseValidityCache: null,
      isCapCloud: false,
    };
  }
  // handle 200: license is valid
  if (licenseServerResponseCode === 200) {
    newPartialServerConfig = {
      licenseValid: true,
      licenseValidityCache: licenseServerResponseJson.refresh,
      isCapCloud: licenseServerResponseJson.isCapCloudLicense,
    };
  }
  newPartialServerConfig &&
    (await db
      .update(serverConfigTable)
      .set(newPartialServerConfig)
      .where(eq(serverConfigTable.id, 1)));

  return {
    ...serverConfig,
    ...newPartialServerConfig,
  };
}

// check if a single user is a member of a pro workspace
export async function isUserPro({ userId }: { userId: string }) {
  const serverConfig = await getServerConfig();
  if (!serverConfig.licenseKey) {
    return false;
  }
  const isCapCloud = serverConfig.isCapCloud;

  // if self hosting, all users on the server have the same pro status as the server itself
  if (!isCapCloud) {
    return serverConfig.licenseValid;
  }

  // check user pro cache status
  const userResponse = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!userResponse) {
    return false;
  }

  // if user is pro and pro expires at is in the future, return true
  if (
    userResponse.pro &&
    userResponse.proExpiresAt &&
    userResponse.proExpiresAt > new Date()
  ) {
    return true;
  }

  // refresh user pro cache
  const userWorkspaceMembershipWorkspaceIds =
    await getUserWorkspaceMembershipWorkspaceIds();

  const licenseServerResponse = (await fetch(
    `${LICENSE_SERVER_URL}/api/instances/cloudPro/user`,
    {
      method: "POST",
      headers: {
        licenseKey: serverConfig.licenseKey,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceIds: userWorkspaceMembershipWorkspaceIds,
      }),
    }
  ).then((res) => res.json())) as {
    isPro: boolean;
    viaWorkspaceId: string | null;
    cacheRefresh: number | null;
  };

  await db
    .update(users)
    .set({
      pro: licenseServerResponse.isPro,
      proExpiresAt: licenseServerResponse.cacheRefresh
        ? new Date(licenseServerResponse.cacheRefresh)
        : null,
      proWorkspaceId: licenseServerResponse.viaWorkspaceId,
    })
    .where(eq(users.id, userId));

  return licenseServerResponse.isPro;
}

// check if a single workspace is a pro workspace
export async function isWorkspacePro({ workspaceId }: { workspaceId: string }) {
  const serverConfig = await getServerConfig();
  if (!serverConfig.licenseKey) {
    return false;
  }
  const isCapCloud = serverConfig.isCapCloud;

  // if self hosting, all workspaces on the server have the same pro status as the server itself
  if (!isCapCloud) {
    return serverConfig.licenseValid;
  }

  // check workspace pro cache status
  const workspaceResponse = await db.query.spaces.findFirst({
    where: eq(spaces.id, workspaceId),
  });

  if (!workspaceResponse) {
    return false;
  }

  // if workspace is pro and pro expires at is in the future, return true
  if (
    workspaceResponse.pro &&
    workspaceResponse.proExpiresAt &&
    workspaceResponse.proExpiresAt > new Date()
  ) {
    return true;
  }

  // refresh workspace pro cache
  const licenseServerResponse = (await fetch(
    `${LICENSE_SERVER_URL}/api/instances/cloudPro/workspace`,
    {
      method: "POST",
      headers: {
        licenseKey: serverConfig.licenseKey,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: workspaceId,
      }),
    }
  ).then((res) => res.json())) as {
    isPro: boolean;
    workspaceId: string;
    cacheRefresh: number | null;
  };

  await db
    .update(spaces)
    .set({
      pro: licenseServerResponse.isPro,
      proExpiresAt: licenseServerResponse.cacheRefresh
        ? new Date(licenseServerResponse.cacheRefresh)
        : null,
      proWorkspaceId: licenseServerResponse.workspaceId,
    })
    .where(eq(spaces.id, workspaceId));

  return licenseServerResponse.isPro;
}
