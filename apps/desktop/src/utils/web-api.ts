import { ApiFetcher, initClient } from "@ts-rest/core";
import { contract, licenseContract } from "@cap/web-api-contract";
import { fetch } from "@tauri-apps/plugin-http";

import { clientEnv } from "./env";
import { authStore } from "~/store";

const api: ApiFetcher = async (args) => {
  const bypassSecret = import.meta.env.VITE_VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) args.headers["x-vercel-protection-bypass"] = bypassSecret;

  const resp = await fetch(args.path, args);

  let body;

  const contentType = resp.headers.get("content-type");
  if (contentType === "application/json") {
    body = await resp.json();
  } else {
    body = await resp.text();
  }

  console.log({ body });

  return {
    body,
    status: resp.status,
    headers: resp.headers,
  };
};

export const apiClient = initClient(contract, {
  baseUrl: `${clientEnv.VITE_SERVER_URL}/api`,
  api,
});
export const licenseApiClient = initClient(licenseContract, {
  baseUrl: `https://l.cap.so/api`,
  api,
});

export async function maybeProtectedHeaders() {
  const store = await authStore.get();

  let token: string | undefined;
  if (store?.secret && "api_key" in store.secret) {
    token = store.secret.api_key;
  } else if (store?.secret && "token" in store.secret) {
    token = store.secret.token;
  }

  return { authorization: token ? `Bearer ${token}` : undefined };
}

export async function protectedHeaders() {
  const { authorization } = await maybeProtectedHeaders();
  if (!authorization) throw new Error("Not authorized");
  console.log({ authorization });
  return { authorization };
}
