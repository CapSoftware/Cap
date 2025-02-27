"use server";

import { getServerConfig as getServerConfigInternal } from "@/utils/instance/functions";

export async function getServerConfigAction() {
  const serverConfig = await getServerConfigInternal();
  return {
    isCapCloud: serverConfig.isCapCloud,
  };
}
