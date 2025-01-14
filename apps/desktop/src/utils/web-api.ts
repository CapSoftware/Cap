import { initClient } from "@ts-rest/core";
import { contract } from "@cap/web-api-contract";
import { clientEnv } from "./env";
import { authStore } from "~/store";

export const apiClient = initClient(contract, {
  baseUrl: clientEnv.VITE_SERVER_URL ? `${clientEnv.VITE_SERVER_URL}/api` : "http://localhost:3000/api",
});

export const protectedHeaders = async () => {
  const token = (await authStore.get())?.token;
  if (!token) throw new Error("Not authorized");
  
  return {
    authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
};
