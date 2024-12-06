import { initClient } from "@ts-rest/core";
import { contract } from "@cap/web-api-contract";

export const apiClient = initClient(contract, {
  baseUrl:
    typeof window !== "undefined"
      ? `${process.env.NEXT_PUBLIC_URL}/api`
      : "/api",
});
