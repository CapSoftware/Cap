"use server";

import {
  getServerConfig as getServerConfigInternal,
  canInstanceAddUser,
  isWorkspacePro,
} from "@/utils/instance/functions";
import { serverEnv } from "@cap/env";

export async function getServerConfigAction() {
  const serverConfig = await getServerConfigInternal();

  const googleSigninEnabled = serverEnv.GOOGLE_CLIENT_ID !== undefined;
  const workosSigninEnabled = serverEnv.WORKOS_CLIENT_ID !== undefined;
  return {
    isCapCloud: serverConfig.isCapCloud,
    signupsEnabled: serverConfig.signupsEnabled,
    auth: {
      google: googleSigninEnabled,
      workos: workosSigninEnabled,
    },
  };
}

export async function canInstanceAddUserAction() {
  return await canInstanceAddUser();
}

export async function isWorkspaceProAction(workspaceId: string) {
  "use server";
  return isWorkspacePro({ workspaceId });
}
