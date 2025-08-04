import { buildEnv } from "@cap/env";
import { serverEnv } from "@cap/env";
import { cookies } from "next/headers";
import { PostHog } from "posthog-node";
import { cache } from "react";
import { v4 as uuidv4 } from "uuid";

export const generateId = cache(() => {
  const id = uuidv4();
  return id;
});

export interface BootstrapData {
  distinctID: string;
  featureFlags: Record<string, string | boolean>;
}

export const getBootstrapData = cache(async (): Promise<BootstrapData> => {
  if (!buildEnv.NEXT_PUBLIC_POSTHOG_KEY)
    return {
      distinctID: "",
      featureFlags: {},
    };

  let distinct_id = "";
  const phProjectAPIKey = buildEnv.NEXT_PUBLIC_POSTHOG_KEY;
  const phCookieName = `ph_${phProjectAPIKey}_posthog`;
  const cookieStore = cookies();
  const phCookie = cookieStore.get(phCookieName);

  if (phCookie) {
    try {
      const phCookieParsed = JSON.parse(phCookie.value);
      distinct_id = phCookieParsed.distinct_id;
    } catch (e) {
      console.error("Error parsing PostHog cookie:", e);
    }
  }

  if (!distinct_id) {
    distinct_id = generateId();
  }

  const client = new PostHog(phProjectAPIKey, {
    host: buildEnv.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com",
    personalApiKey: serverEnv().POSTHOG_PERSONAL_API_KEY,
  });

  const flags = await client.getAllFlags(distinct_id);

  const bootstrap: BootstrapData = {
    distinctID: distinct_id,
    featureFlags: flags,
  };

  return bootstrap;
});
