"use client";

import { useEffect, useState } from "react";
import { identifyUser, initAnonymousUser } from "./utils/analytics";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { clientEnv } from "@cap/env";
import PostHogPageView from "./PosthogPageView";
import Intercom from "@intercom/messenger-js-sdk";
import { getServerConfig } from "@/utils/instance/functions";
import { AuthProvider } from "./AuthProvider";
import { BentoScript } from "@/components/BentoScript";

// Internal PostHog provider component
function PostHogWrapper({ children }: { children: React.ReactNode }) {
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

// Single exported Providers component
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
  const [isCapCloud, setIsCapCloud] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkIsCapCloud = async () => {
      try {
        const serverConfig = await getServerConfig();
        setIsCapCloud(serverConfig.isCapCloud);
      } catch (error) {
        console.error("Failed to get server config:", error);
        setIsCapCloud(false); // Default to false on error
      } finally {
        setIsLoading(false);
      }
    };

    checkIsCapCloud();
  }, []);

  // Initialize Intercom and analytics if isCapCloud is true
  useEffect(() => {
    if (!isCapCloud) return;

    // Initialize Intercom
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

    // Initialize analytics identification
    if (!userId) {
      initAnonymousUser();
    } else {
      identifyUser(userId);
    }
  }, [userId, intercomHash, name, email, isCapCloud]);

  // Show nothing during initial load to prevent flash of content
  if (isLoading) {
    return null;
  }

  // Always wrap with AuthProvider, but conditionally wrap with PostHog if isCapCloud
  return (
    <AuthProvider>
      {isCapCloud ? (
        <>
          <PostHogWrapper>
            {children}
            {email && <BentoScript userEmail={email} />}
          </PostHogWrapper>
        </>
      ) : (
        children
      )}
    </AuthProvider>
  );
}
