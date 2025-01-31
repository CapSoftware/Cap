"use client";

import { clientEnv } from "@cap/env";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { ReactNode } from "react";

if (typeof window !== "undefined") {
  posthog.init(clientEnv.NEXT_PUBLIC_POSTHOG_KEY as string, {
    api_host: clientEnv.NEXT_PUBLIC_POSTHOG_HOST as string,
  });
}
export function CSPostHogProvider({ children }: { children: ReactNode }) {
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
