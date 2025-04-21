"use client";

import { useEffect } from "react";
import { identifyUser, initAnonymousUser, trackEvent } from "./utils/analytics";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { clientEnv } from "@cap/env";
import PostHogPageView from "./PosthogPageView";
// import Intercom from "@intercom/messenger-js-sdk";
import { usePathname } from "next/navigation";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = clientEnv.NEXT_PUBLIC_POSTHOG_KEY;
    const host = clientEnv.NEXT_PUBLIC_POSTHOG_HOST;

    if (key && host) {
      try {
        posthog.init(key, {
          api_host: host,
          capture_pageview: false,
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
  }, []);

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
    // Commenting out Intercom initialization
    // if (intercomHash === "") {
    //   Intercom({
    //     api_base: "https://api-iam.intercom.io",
    //     app_id: "YOUR_APP_ID",
    //   });
    // } else {
    //   Intercom({
    //     api_base: "https://api-iam.intercom.io",
    //     app_id: "YOUR_APP_ID",
    //     user_id: userId,
    //     name: name,
    //     email: email,
    //     user_hash: intercomHash ?? "",
    //   });
    // }
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
  name,
  email,
  isSharePage,
  intercomHash,
}: {
  children: React.ReactNode;
  userId?: string;
  name?: string;
  email?: string;
  isSharePage?: boolean;
  intercomHash?: string;
}) {
  useEffect(() => {
    // Commenting out Intercom initialization
    // if (intercomHash === "") {
    //   Intercom({
    //     api_base: "https://api-iam.intercom.io",
    //     app_id: "YOUR_APP_ID",
    //   });
    // } else {
    //   Intercom({
    //     api_base: "https://api-iam.intercom.io",
    //     app_id: "YOUR_APP_ID",
    //     user_id: userId,
    //     name: name,
    //     email: email,
    //     user_hash: intercomHash ?? "",
    //   });
    // }
  }, [intercomHash, userId, name, email, isSharePage]);

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
