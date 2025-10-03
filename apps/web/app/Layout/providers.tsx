"use client";

import { buildEnv } from "@cap/env";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { type PropsWithChildren, useEffect, useState } from "react";

import PostHogPageView from "./PosthogPageView";

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
			console.warn(
				"Missing PostHog environment variables. Events will not be tracked.",
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

export function ReactQueryProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [queryClient] = useState(() => new QueryClient());

	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

import { SessionProvider as NASessionProvider } from "next-auth/react";

export function SessionProvider({ children }: PropsWithChildren) {
	return <NASessionProvider>{children}</NASessionProvider>;
}
