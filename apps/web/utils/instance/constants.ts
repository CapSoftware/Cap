import { clientEnv } from "@cap/env";

export const LICENSE_SERVER_URL =
  process.env.NODE_ENV === "production"
    ? "https://l.cap.so"
    : "http://localhost:3100";
export const INSTANCE_SITE_URL = clientEnv.NEXT_PUBLIC_WEB_URL;
