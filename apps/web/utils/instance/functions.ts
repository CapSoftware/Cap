import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { serverConfigTable, spaces, users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { INSTANCE_SITE_URL, LICENSE_SERVER_URL } from "./constants";
import {
  getCloudWorkspaceUserCount,
  getServerUserCount,
  getUserWorkspaceMembershipWorkspaceIds,
} from "./helpers";

export const getServerConfig = async (): Promise<
  typeof serverConfigTable.$inferSelect
> => {
  console.log("[function call: getServerConfig");
  const serverConfig = await db.query.serverConfigTable.findFirst({
    where: eq(serverConfigTable.id, 1),
  });

  console.log("[function call: getServerConfig: serverConfig", {
    serverConfig,
  });
  // create server config object if it doesn't exist
  if (!serverConfig) {
    console.log("[function call: getServerConfig: serverConfig not found");
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
    console.log("[function call: getServerConfig: newServerConfig", {
      newServerConfig,
    });
    await db.insert(serverConfigTable).values(newServerConfig);
    console.log("[function call: getServerConfig returning newServerConfig");
    return newServerConfig;
  }

  if (
    serverConfig.licenseKey &&
    (serverConfig.licenseValidityCache === null ||
      serverConfig.licenseValidityCache.getTime() < Date.now())
  ) {
    console.log("[function call: getServerConfig: ifStatement", {
      licenseKey: serverConfig.licenseKey,
      licenseValidityCache: serverConfig.licenseValidityCache,
      dateNow: Date.now(),
    });
    const validationResult = await validateServerLicense({
      serverConfig,
    });
    console.log("[function call: getServerConfig: validationResult", {
      validationResult,
    });
    return validationResult;
  }

  return serverConfig;
};

// check if the server is a Cap Cloud server
export const isCapCloud = async (): Promise<boolean> => {
  console.log("[function call: isCapCloud");
  const serverConfig = await getServerConfig();
  console.log("[function call: isCapCloud: serverConfig", { serverConfig });
  return serverConfig.isCapCloud;
};

// Used in self hosted instances to add a user to the server superAdminIds array
export const addServerSuperAdmin = async ({ userId }: { userId: string }) => {
  console.log("[function call: addServerSuperAdmin input", { userId });
  const currentUser = await getCurrentUser();
  console.log("[function call: addServerSuperAdmin: currentUser", {
    currentUser,
  });
  if (!currentUser) {
    console.log("[function call: addServerSuperAdmin: currentUser not found");
    throw new Error("Not authorized");
  }

  const serverConfig = await getServerConfig();
  console.log("[function call: addServerSuperAdmin: serverConfig", {
    serverConfig,
  });
  const existingSuperAdminIds = serverConfig.superAdminIds;
  console.log("[function call: addServerSuperAdmin: existingSuperAdminIds", {
    existingSuperAdminIds,
  });
  if (
    existingSuperAdminIds.length > 0 &&
    !existingSuperAdminIds.includes(currentUser.id)
  ) {
    console.log(
      "[function call: addServerSuperAdmin if not in admin array: not authorized"
    );
    throw new Error("Not authorized");
  }

  // update server config superAdminIds array
  await db
    .update(serverConfigTable)
    .set({
      superAdminIds: [...existingSuperAdminIds, userId],
    })
    .where(eq(serverConfigTable.id, 1));
  console.log("[function call: addServerSuperAdmin: updated server config");
  return;
};

// used in all instances to validate the self hosted server license
export async function validateServerLicense({
  serverConfig,
}: {
  serverConfig: typeof serverConfigTable.$inferSelect;
}): Promise<typeof serverConfigTable.$inferSelect> {
  console.log("[function call: validateServerLicense input", { serverConfig });
  if (!serverConfig?.licenseKey) {
    console.log("[function call: validateServerLicense: licenseKey not found");
    return serverConfig;
  }
  console.log("[function call: validateServerLicense: licenseKey", {
    licenseKey: serverConfig.licenseKey,
  });
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
  console.log("[function call: validateServerLicense: licenseServerResponse", {
    licenseServerResponse,
  });

  const licenseServerResponseCode = await licenseServerResponse.status;
  const licenseServerResponseJson = await licenseServerResponse.json();
  console.log(
    "[function call: validateServerLicense: licenseServerResponseJson",
    {
      licenseServerResponseJson,
    }
  );

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
    console.log(
      "[function call: validateServerLicense: licenseServerResponseCode",
      {
        licenseServerResponseCode,
      }
    );
    newPartialServerConfig = {
      licenseValid: false,
      licenseValidityCache: null,
      isCapCloud: false,
    };
    console.log(
      "[function call: validateServerLicense: newPartialServerConfig",
      {
        newPartialServerConfig,
      }
    );
  }
  // handle 200: license is valid
  if (licenseServerResponseCode === 200) {
    console.log("[function call: validateServerLicense: 200: license is valid");
    newPartialServerConfig = {
      licenseValid: true,
      licenseValidityCache: new Date(licenseServerResponseJson.refresh),
      isCapCloud: licenseServerResponseJson.isCapCloudLicense,
    };
    console.log(
      "[function call: validateServerLicense: newPartialServerConfig",
      {
        newPartialServerConfig,
      }
    );
  }
  console.log("[function call: validateServerLicense: updating server config");
  newPartialServerConfig &&
    (await db
      .update(serverConfigTable)
      .set(newPartialServerConfig)
      .where(eq(serverConfigTable.id, 1)));
  console.log(
    "[function call: validateServerLicense: returning server config",
    {
      ...serverConfig,
      ...newPartialServerConfig,
    }
  );
  return {
    ...serverConfig,
    ...newPartialServerConfig,
  };
}

// check if a single user is a member of a pro workspace
export async function getIsUserPro({ userId }: { userId: string }) {
  console.log("[function call: getIsUserPro input", { userId });
  const serverConfig = await getServerConfig();
  console.log("[function call: getIsUserPro: serverConfig", { serverConfig });
  if (!serverConfig.licenseKey) {
    console.log("[function call: getIsUserPro: licenseKey not found");
    return false;
  }
  console.log("[function call: getIsUserPro: ifStatement", {
    licenseKey: serverConfig.licenseKey,
    isCapCloud: serverConfig.isCapCloud,
  });
  // if self hosting, all users on the server have the same pro status as the server itself
  if (!serverConfig.isCapCloud) {
    console.log(
      "[function call: getIsUserPro: ifStatement: self hosting: returning licenseValid"
    );
    return serverConfig.licenseValid;
  }

  // check user pro cache status
  const userResponse = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  console.log("[function call: getIsUserPro: userResponse", { userResponse });
  if (!userResponse) {
    console.log("[function call: getIsUserPro: userResponse not found");
    return false;
  }

  // if user is pro and pro expires at is in the future, return true
  if (
    userResponse.pro &&
    userResponse.proExpiresAt &&
    userResponse.proExpiresAt > new Date()
  ) {
    console.log("[function call: getIsUserPro: user is pro: returning true");
    return true;
  }

  // refresh user pro cache
  const userWorkspaceMembershipWorkspaceIds =
    await getUserWorkspaceMembershipWorkspaceIds();
  console.log(
    "[function call: getIsUserPro: userWorkspaceMembershipWorkspaceIds",
    {
      userWorkspaceMembershipWorkspaceIds,
    }
  );
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
  console.log("[function call: getIsUserPro: licenseServerResponse", {
    licenseServerResponse,
  });

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
  console.log("[function call: getIsUserPro: updated user");
  console.log(
    "[function call: getIsUserPro: returning licenseServerResponse.isPro",
    {
      licenseServerResponse,
    }
  );
  return licenseServerResponse.isPro;
}

// check if a single workspace is a pro workspace
export async function isWorkspacePro({ workspaceId }: { workspaceId: string }) {
  console.log("[function call: isWorkspacePro input", { workspaceId });
  const serverConfig = await getServerConfig();
  console.log("[function call: isWorkspacePro: serverConfig", { serverConfig });
  if (!serverConfig.licenseKey) {
    console.log("[function call: isWorkspacePro: licenseKey not found");
    return false;
  }

  // if self hosting, all workspaces on the server have the same pro status as the server itself
  if (!serverConfig.isCapCloud) {
    console.log(
      "[function call: isWorkspacePro: ifStatement: self hosting: returning licenseValid"
    );
    return serverConfig.licenseValid;
  }

  // check workspace pro cache status
  const workspaceResponse = await db.query.spaces.findFirst({
    where: eq(spaces.id, workspaceId),
  });
  console.log("[function call: isWorkspacePro: workspaceResponse", {
    workspaceResponse,
  });
  if (!workspaceResponse) {
    console.log("[function call: isWorkspacePro: workspaceResponse not found");
    return false;
  }

  // if workspace is pro and pro expires at is in the future, return true
  if (
    workspaceResponse.pro &&
    workspaceResponse.proExpiresAt &&
    workspaceResponse.proExpiresAt > new Date()
  ) {
    console.log(
      "[function call: isWorkspacePro: workspace is pro: returning true"
    );
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
  console.log("[function call: isWorkspacePro: licenseServerResponse", {
    licenseServerResponse,
  });

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
  console.log("[function call: isWorkspacePro: updated workspace");
  console.log(
    "[function call: isWorkspacePro: returning licenseServerResponse.isPro",
    {
      licenseServerResponse,
    }
  );
  return licenseServerResponse.isPro;
}

// Update workspace user counts - This includes both users and invites
export async function updateCloudWorkspaceUserCount({
  workspaceId,
}: {
  workspaceId: string;
}) {
  console.log("[function call: updateCloudWorkspaceUserCount input", {
    workspaceId,
  });
  const serverConfig = await getServerConfig();
  console.log("[function call: updateCloudWorkspaceUserCount: serverConfig", {
    serverConfig,
  });
  if (!serverConfig.licenseKey) {
    console.log(
      "[function call: updateCloudWorkspaceUserCount: licenseKey not found"
    );
    return false;
  }

  // if selfhosting, seats will be updated on next server license check automatically
  if (!serverConfig.isCapCloud) {
    console.log(
      "[function call: updateCloudWorkspaceUserCount: ifStatement: self hosting: returning true"
    );
    return true;
  }

  const workspaceUserCount = await getCloudWorkspaceUserCount({ workspaceId });
  console.log(
    "[function call: updateCloudWorkspaceUserCount: workspaceUserCount",
    {
      workspaceUserCount,
    }
  );
  try {
    await fetch(
      `${LICENSE_SERVER_URL}/api/instances/cloudPro/workspace/addUser`,
      {
        method: "POST",
        headers: {
          licenseKey: serverConfig.licenseKey,
          siteUrl: INSTANCE_SITE_URL,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: workspaceId,
          seatCount: workspaceUserCount,
        }),
      }
    );
    console.log(
      "[function call: updateCloudWorkspaceUserCount: updated workspace"
    );
    return true;
  } catch (error) {
    console.log("[function call: updateCloudWorkspaceUserCount: error", {
      error,
    });
    console.error(error);
    return false;
  }
}

export async function generateCloudProStripeCheckoutSession({
  cloudWorkspaceId,
  cloudUserId,
  email,
  type,
}: {
  cloudWorkspaceId: string;
  cloudUserId: string;
  email: string;
  type: "yearly" | "monthly";
}) {
  console.log("[function call: generateCloudProStripeCheckoutSession input", {
    cloudWorkspaceId,
    cloudUserId,
    email,
    type,
  });
  const serverConfig = await getServerConfig();
  console.log(
    "[function call: generateCloudProStripeCheckoutSession: serverConfig",
    {
      serverConfig,
    }
  );
  if (!serverConfig.licenseKey) {
    console.log(
      "[function call: generateCloudProStripeCheckoutSession: licenseKey not found"
    );
    return false;
  }

  if (!serverConfig.isCapCloud) {
    console.log(
      "[function call: generateCloudProStripeCheckoutSession: ifStatement: self hosting: returning false"
    );
    return false;
  }

  const seatCount = await getCloudWorkspaceUserCount({
    workspaceId: cloudWorkspaceId,
  });
  console.log(
    "[function call: generateCloudProStripeCheckoutSession: seatCount",
    {
      seatCount,
    }
  );
  // refresh workspace pro cache
  const licenseServerResponse = (await fetch(
    `${LICENSE_SERVER_URL}/api/instances/cloudPro/workspace/checkout`,
    {
      method: "POST",
      headers: {
        licenseKey: serverConfig.licenseKey,
        siteUrl: INSTANCE_SITE_URL,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cloudWorkspaceId: cloudWorkspaceId,
        cloudUserId: cloudUserId,
        email: email,
        seatCount: seatCount,
        type: type,
      }),
    }
  ).then((res) => res.json())) as {
    workspaceId: string;
    newSeatCount: number;
    checkoutLink: string;
  };
  console.log(
    "[function call: generateCloudProStripeCheckoutSession: licenseServerResponse",
    {
      licenseServerResponse,
    }
  );
  return licenseServerResponse;
}

export async function generateCloudProStripePortalLink({
  cloudWorkspaceId,
}: {
  cloudWorkspaceId: string;
}) {
  console.log("[function call: generateCloudProStripePortalLink input", {
    cloudWorkspaceId,
  });
  const serverConfig = await getServerConfig();
  console.log(
    "[function call: generateCloudProStripePortalLink: serverConfig",
    {
      serverConfig,
    }
  );
  if (!serverConfig.licenseKey) {
    console.log(
      "[function call: generateCloudProStripePortalLink: licenseKey not found"
    );
    return false;
  }

  if (!serverConfig.isCapCloud) {
    console.log(
      "[function call: generateCloudProStripePortalLink: ifStatement: self hosting: returning false"
    );
    return false;
  }

  const seatCount = await getCloudWorkspaceUserCount({
    workspaceId: cloudWorkspaceId,
  });
  console.log("[function call: generateCloudProStripePortalLink: seatCount", {
    seatCount,
  });
  // refresh workspace pro cache
  try {
    console.log(
      "[function call: generateCloudProStripePortalLink: trying to fetch licenseServerResponse"
    );
    const licenseServerResponse = (await fetch(
      `${LICENSE_SERVER_URL}/api/instances/cloudPro/workspace/portal`,
      {
        method: "POST",
        headers: {
          licenseKey: serverConfig.licenseKey,
          siteUrl: INSTANCE_SITE_URL,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          cloudWorkspaceId: cloudWorkspaceId,
          seatCount: seatCount,
        }),
      }
    ).then((res) => res.json())) as {
      workspaceId: string;
      newSeatCount: number;
      portalLink: string;
    };

    console.log(
      "[function call: generateCloudProStripePortalLink: licenseServerResponse",
      {
        licenseServerResponse,
      }
    );
    console.log(
      "[function call: generateCloudProStripePortalLink: returning licenseServerResponse"
    );
    return licenseServerResponse;
  } catch (error) {
    console.error(error);
    console.log("[function call: generateCloudProStripePortalLink: error", {
      error,
    });
    return null;
  }
}
