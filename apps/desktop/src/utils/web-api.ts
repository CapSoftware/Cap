import { initClient } from "@ts-rest/core";
import { contract } from "@cap/web-api-contract";
import { fetch } from "@tauri-apps/plugin-http";

import { clientEnv } from "./env";
import { authStore } from "~/store";

const baseUrl = `${clientEnv.VITE_SERVER_URL}/api`;
export const apiClient = initClient(contract, {
  baseUrl,
  api: async (args) => {
    const resp = await fetch(args.path, args);

    let body;

    const contentType = resp.headers.get("content-type");
    if (contentType === "application/json") {
      body = await resp.json();
    } else {
      body = await resp.text();
    }

    return {
      body,
      status: resp.status,
      headers: resp.headers,
    };
  },
});

export async function maybeProtectedHeaders() {
  const token = (await authStore.get())?.token;
  return { authorization: token ? `Bearer ${token}` : undefined };
}

export async function protectedHeaders() {
  const { authorization } = await maybeProtectedHeaders();
  if (!authorization) throw new Error("Not authorized");
  return { authorization };
}
