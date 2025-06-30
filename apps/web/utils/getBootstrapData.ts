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
  allowedEmails: string[];
}

export const getBootstrapData = cache(async (): Promise<BootstrapData> => {
  if (!buildEnv.NEXT_PUBLIC_POSTHOG_KEY)
    return {
      distinctID: "",
      featureFlags: {},
      allowedEmails: [],
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

  let allowedEmails: string[] = [];
  try {
    const remoteConfigPayload = await client.getRemoteConfigPayload(
      "cap-ai-testers"
    );

    if (remoteConfigPayload) {
      let parsedPayload = remoteConfigPayload;
      if (typeof remoteConfigPayload === "string") {
        try {
          parsedPayload = JSON.parse(remoteConfigPayload);
        } catch (parseError) {
          console.error(
            "Error parsing remote config payload as JSON:",
            parseError
          );
        }
      }

      if (
        parsedPayload &&
        typeof parsedPayload === "object" &&
        !Array.isArray(parsedPayload) &&
        "emails" in parsedPayload
      ) {
        const emails = (parsedPayload as { emails: unknown }).emails;

        if (Array.isArray(emails)) {
          allowedEmails = emails.filter(
            (email): email is string => typeof email === "string"
          );
        }
      }
    }
  } catch (e) {
    console.error("Error fetching PostHog remote config:", e);
  }

  const bootstrap: BootstrapData = {
    distinctID: distinct_id,
    featureFlags: flags,
    allowedEmails,
  };

  return bootstrap;
});
