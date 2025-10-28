"use client";

import { buildEnv } from "@cap/env";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import type { PostHogConfig } from "posthog-js";
import { PostHogProvider as PHProvider, usePostHog } from "posthog-js/react";
import {
	type PropsWithChildren,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { BootstrapData } from "@/utils/getBootstrapData";

import PostHogPageView from "./PosthogPageView";

export function PostHogProvider({
	children,
	bootstrapData,
}: PropsWithChildren<{ bootstrapData?: BootstrapData }>) {
	const key = buildEnv.NEXT_PUBLIC_POSTHOG_KEY;
	const host = buildEnv.NEXT_PUBLIC_POSTHOG_HOST;
	const initialBootstrap = useRef<BootstrapData | undefined>(undefined);

	if (!initialBootstrap.current && bootstrapData?.distinctID) {
		initialBootstrap.current = bootstrapData;
	}

	const options = useMemo(() => {
		if (!host) return undefined;
		const base = {
			api_host: host,
			capture_pageview: false,
			bootstrap: initialBootstrap.current?.distinctID
				? initialBootstrap.current
				: undefined,
		} satisfies Partial<PostHogConfig>;

		if (process.env.NEXT_PUBLIC_POSTHOG_DISABLE_SESSION_RECORDING === "true") {
			(base as any).disable_session_recording = true;
		}

		return base;
	}, [host]);

	if (!key || !host || !options) {
		if (process.env.NODE_ENV !== "production") {
			console.warn(
				"Missing PostHog environment variables. Events will not be tracked.",
			);
		}
		return <>{children}</>;
	}

	return (
		<PHProvider apiKey={key} options={options}>
			<PostHogPageView />
			<PostHogBootstrapSync bootstrapData={bootstrapData} />
			{children}
		</PHProvider>
	);
}

function PostHogBootstrapSync({
	bootstrapData,
}: {
	bootstrapData?: BootstrapData;
}) {
	const posthog = usePostHog();
	const previousFlags = useRef<Record<string, string | boolean> | undefined>(
		undefined,
	);

	useEffect(() => {
		if (!posthog || !bootstrapData) {
			return;
		}

		const nextFlags = bootstrapData.featureFlags ?? {};

		if (areFlagMapsEqual(previousFlags.current, nextFlags)) {
			return;
		}

		if (typeof posthog.featureFlags?.override === "function") {
			posthog.featureFlags.override(nextFlags);
			previousFlags.current = nextFlags;
		}
	}, [posthog, bootstrapData]);

	return null;
}

function areFlagMapsEqual(
	left?: Record<string, string | boolean>,
	right?: Record<string, string | boolean>,
) {
	if (left === right) {
		return true;
	}
	if (!left || !right) {
		return !left && !right;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	return leftKeys.every((key) => left[key] === right[key]);
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
import {
	demoteFromPro,
	promoteToPro,
	restartOnboarding,
} from "./devtoolsServer";
import { useFeatureFlags } from "./features";

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
	void flags;

	return (
		<div className="flex flex-col p-4 space-y-4">
			<h1 className="text-2xl font-semibold">Cap Devtools</h1>
			{/*<div className="space-y-2">
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
			</div>*/}
			<div className="space-y-2">
				<h1 className="text-lg font-semibold">Cap Pro</h1>
				<p className="text-xs text-muted-foreground">
					Toggle the current user's Pro status (dev only)
				</p>
				<div className="flex items-center space-x-2">
					<form action={promoteToPro}>
						<button
							type="submit"
							className="px-2 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700"
						>
							Promote to Pro
						</button>
					</form>
					<form action={demoteFromPro}>
						<button
							type="submit"
							className="px-2 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700"
						>
							Demote from Pro
						</button>
					</form>
				</div>
			</div>
			<div className="space-y-2">
				<h1 className="text-lg font-semibold">Onboarding</h1>
				<p className="text-xs text-muted-foreground">
					Restart the onboarding process for the current user (dev only)
				</p>
				<form action={restartOnboarding}>
					<button
						type="submit"
						className="px-2 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
					>
						Restart Onboarding
					</button>
				</form>
			</div>
		</div>
	);
}
