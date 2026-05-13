"use client";

import { buildEnv } from "@cap/env";
import {
	TanStackDevtools,
	type TanStackDevtoolsReactInit,
} from "@tanstack/react-devtools";
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

type CapPostHogConfig = Partial<PostHogConfig> & {
	disable_session_recording?: boolean;
};

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
		const base: CapPostHogConfig = {
			api_host: host,
			capture_pageview: false,
			capture_pageleave: true,
			bootstrap: initialBootstrap.current?.distinctID
				? initialBootstrap.current
				: undefined,
		};

		if (process.env.NEXT_PUBLIC_POSTHOG_DISABLE_SESSION_RECORDING === "true") {
			base.disable_session_recording = true;
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

export function SessionProvider({ children }: PropsWithChildren) {
	return <NASessionProvider>{children}</NASessionProvider>;
}

type DevtoolsConfig = NonNullable<TanStackDevtoolsReactInit["config"]>;

const devtoolsSettingsStorageKey = "tanstack_devtools_settings";

const devtoolsConfig = {
	hideUntilHover: false,
	position: "top-left",
	requireUrlFlag: false,
} satisfies DevtoolsConfig;

function getDevtoolsSettings(value: string | null): DevtoolsConfig {
	if (!value) return devtoolsConfig;

	try {
		const parsed: unknown = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				...parsed,
				...devtoolsConfig,
			};
		}
	} catch {
		return devtoolsConfig;
	}

	return devtoolsConfig;
}

function persistDevtoolsSettings() {
	if (typeof window === "undefined") return;

	try {
		window.localStorage.setItem(
			devtoolsSettingsStorageKey,
			JSON.stringify(
				getDevtoolsSettings(
					window.localStorage.getItem(devtoolsSettingsStorageKey),
				),
			),
		);
	} catch {
		return;
	}
}

export function Devtools() {
	const client = useQueryClient();
	const [isReady, setIsReady] = useState(false);

	useEffect(() => {
		persistDevtoolsSettings();
		setIsReady(true);
	}, []);

	if (!isReady) return null;

	return (
		<TanStackDevtools
			config={devtoolsConfig}
			plugins={[
				{
					id: "cap",
					name: "Cap",
					render: <CapDevtools />,
				},
				{
					id: "tanstack-query",
					name: "Tanstack Query",
					render: <ReactQueryDevtoolsPanel client={client} />,
				},
			]}
		/>
	);
}

function CapDevtools() {
	return (
		<div className="flex flex-col p-4 space-y-4">
			<h1 className="text-2xl font-semibold">Cap Devtools</h1>
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
