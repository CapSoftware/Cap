"use client";

import { useEffect, useState } from "react";
import { identifyUser, initAnonymousUser } from "./utils/analytics";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { clientEnv } from "@cap/env";
import PostHogPageView from "./PosthogPageView";
import Intercom from "@intercom/messenger-js-sdk";
import { AuthProvider } from "./AuthProvider";
import { BentoScript } from "@/components/BentoScript";
import { getServerConfigAction } from "./actions";
import { NuqsAdapter } from "nuqs/adapters/next/app";

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
  initialIsCapCloud,
}: {
  children: React.ReactNode;
  userId?: string;
  intercomHash?: string;
  name?: string;
  email?: string;
  initialIsCapCloud?: boolean;
}) {
  const [isCapCloud, setIsCapCloud] = useState<boolean | null>(
    initialIsCapCloud ?? null
  );
  const [isLoading, setIsLoading] = useState(
    initialIsCapCloud !== undefined ? false : true
  );

  useEffect(() => {
    const checkIsCapCloud = async () => {
      if (initialIsCapCloud !== undefined) {
        return; // Skip fetching if we already have the value
      }

      try {
        const serverConfig = await getServerConfigAction();
        setIsCapCloud(serverConfig.isCapCloud);
      } catch (error) {
        console.error("Failed to get server config:", error);
        setIsCapCloud(false); // Default to false on error
      } finally {
        setIsLoading(false);
      }
    };

    checkIsCapCloud();
  }, [initialIsCapCloud]);

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
    <NuqsAdapter>
      <AuthProvider>
        {isCapCloud ? (
          <>
            <PostHogWrapper>{children}</PostHogWrapper>
            {email && <BentoScript userEmail={email} />}
          </>
        ) : (
          children
        )}
      </AuthProvider>
    </NuqsAdapter>
  );
}
