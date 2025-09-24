"use client";

import { buildEnv } from "@cap/env";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
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
		<QueryClientProvider client={queryClient}>
			{children}
			{process.env.NODE_ENV === "development" ? <Devtools /> : null}
		</QueryClientProvider>
	);
}

import { SessionProvider as NASessionProvider } from "next-auth/react";
import { featureFlags, useFeatureFlags } from "./features";

export function SessionProvider({ children }: PropsWithChildren) {
	return <NASessionProvider>{children}</NASessionProvider>;
}

export function Devtools() {
	const client = useQueryClient();

	return (
		<TanStackDevtools
			config={{
				// TODO: This doesn't seem to be working?
				position: "top-left",
			}}
			plugins={[
				{
					name: "Cap",
					render: <CapDevtools />,
				},
				{
					name: "Tanstack Query",
					render: <ReactQueryDevtoolsPanel client={client} />,
				},
			]}
		/>
	);
}

function CapDevtools() {
	const flags = useFeatureFlags();

	return (
		<div className="flex flex-col space-y-4 p-4">
			<h1 className="text-2xl font-semibold">Cap Devtools</h1>
			<div className="space-y-2">
				<h1 className="text-lg font-semibold">Features</h1>
				<label className="flex items-center space-x-2">
					<input
						type="checkbox"
						checked={flags.enableUploadProgress}
						onChange={(e) =>
							featureFlags.setState((prev) => ({
								...prev,
								enableUploadProgress: e.target.checked,
							}))
						}
					/>
					<span>Enable Upload Progress UI</span>
				</label>
			</div>
		</div>
	);
}
