"use client";

import { useEffect } from "react";
import { identifyUser, initAnonymousUser } from "./utils/analytics";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { clientEnv } from "@cap/env";
import PostHogPageView from "./PosthogPageView";
import Intercom from "@intercom/messenger-js-sdk";
import { usePathname } from "next/navigation";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(clientEnv.NEXT_PUBLIC_POSTHOG_KEY as string, {
      api_host: clientEnv.NEXT_PUBLIC_POSTHOG_HOST as string,
      capture_pageview: false,
    });
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
      identifyUser(userId);
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
