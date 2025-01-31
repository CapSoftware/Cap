import { initClient } from "@ts-rest/core";
import { contract } from "@cap/web-api-contract";
import { clientEnv } from "@cap/env";

export const apiClient = initClient(contract, {
  baseUrl:
    typeof window !== "undefined"
      ? `${clientEnv.NEXT_PUBLIC_WEB_URL}/api`
      : "/api",
});
