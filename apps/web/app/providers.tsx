"use client";

import { PropsWithChildren, useEffect } from "react";
import { identifyUser, initAnonymousUser, trackEvent } from "./utils/analytics";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { buildEnv } from "@cap/env";
import PostHogPageView from "./PosthogPageView";
import Intercom from "@intercom/messenger-js-sdk";
import { usePathname } from "next/navigation";

export function PostHogProvider({
  children,
  bootstrapData,
}: PropsWithChildren<{
  bootstrapData?: {
    distinctID: string;
    featureFlags: Record<string, string | boolean>;
  };
}>) {
  useEffect(() => {
    const key = buildEnv.NEXT_PUBLIC_POSTHOG_KEY;
    const host = buildEnv.NEXT_PUBLIC_POSTHOG_HOST;

    if (key && host) {
      try {
        posthog.init(key, {
          api_host: host,
          capture_pageview: false,
          bootstrap: bootstrapData,
          loaded: (posthogInstance) => {
            console.log("PostHog loaded and ready to capture events");
          },
        });
      } catch (error) {
        console.error("Failed to initialize PostHog:", error);
      }
    } else {
      console.error(
        "Missing PostHog environment variables. Events will not be tracked."
      );
    }
  }, [bootstrapData]);

  return (
    <PHProvider client={posthog}>
      <PostHogPageView />
      {children}
    </PHProvider>
  );
}

export function AnalyticsProvider({
  children,
  userId,
  intercomHash,
  name,
  email,
}: {
  children: React.ReactNode;
  userId?: string;
  intercomHash?: string;
  name?: string;
  email?: string;
}) {
  const pathname = usePathname();
  const isSharePage = pathname?.startsWith("/s/");

  useEffect(() => {
    if (!isSharePage) {
      if (intercomHash === "") {
        Intercom({
          app_id: "efxq71cv",
          utm_source: "web",
        });
      } else {
        Intercom({
          app_id: "efxq71cv",
          user_id: userId ?? "",
          user_hash: intercomHash ?? "",
          name: name,
          email: email,
          utm_source: "web",
        });
      }
    }
  }, [intercomHash, userId, name, email, isSharePage]);

  useEffect(() => {
    if (!userId) {
      initAnonymousUser();
    } else {
      // Track if this is the first time a user is being identified
      const isNewUser = !localStorage.getItem("user_identified");

      identifyUser(userId);

      if (isNewUser) {
        localStorage.setItem("user_identified", "true");
        trackEvent("user_signed_up");
      }

      trackEvent("user_signed_in");
    }
  }, [userId]);

  return <>{children}</>;
}

export function Providers({
  children,
  userId,
  intercomHash,
  name,
  email,
}: {
  children: React.ReactNode;
  userId?: string;
  intercomHash?: string;
  name?: string;
  email?: string;
}) {
  return (
    <AnalyticsProvider
      userId={userId}
      intercomHash={intercomHash}
      name={name}
      email={email}
    >
      {children}
    </AnalyticsProvider>
  );
}
