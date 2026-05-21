import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps, useNavigate } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { getVersion } from "@tauri-apps/api/app";
import * as dialog from "@tauri-apps/plugin-dialog";
import * as shell from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import {
	createMemo,
	createResource,
	createSignal,
	For,
	Show,
	Suspense,
} from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import { SignInButton } from "~/components/SignInButton";

import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";
import { clientEnv } from "~/utils/env";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import IconLucideUserRound from "~icons/lucide/user-round";

export default function Settings(props: RouteSectionProps) {
	const navigate = useNavigate();
	const auth = authStore.createQuery();
	const [version] = createResource(() => getVersion());
	const [isCheckingForUpdates, setIsCheckingForUpdates] = createSignal(false);
	const userProfile = createQuery(() => ({
		queryKey: ["settings-user-profile", auth.data?.user_id],
		enabled: !!auth.data,
		staleTime: 30 * 60 * 1000,
		gcTime: 2 * 60 * 60 * 1000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async () => {
			const response = await apiClient.desktop.getUserProfile({
				headers: await protectedHeaders(),
			});

			if (response.status !== 200)
				throw new Error("Failed to load account profile");

			return response.body;
		},
	}));
	const settingsItems = [
		{
			href: "general",
			name: "General",
			icon: IconCapSettings,
		},
		{
			href: "hotkeys",
			name: "Shortcuts",
			icon: IconCapHotkeys,
		},
		{
			href: "recordings",
			name: "Recordings",
			icon: IconLucideSquarePlay,
		},
		{
			href: "screenshots",
			name: "Screenshots",
			icon: IconLucideImage,
		},
		{
			href: "transcription",
			name: "Transcription",
			icon: IconCapCaptions,
		},
		{
			href: "integrations",
			name: "Integrations",
			icon: IconLucideUnplug,
		},
		{
			href: "license",
			name: "License",
			icon: IconLucideGift,
		},
		{
			href: "experimental",
			name: "Experimental",
			icon: IconCapSettings,
		},
		{
			href: "feedback",
			name: "Feedback",
			icon: IconLucideMessageSquarePlus,
		},
		{
			href: "changelog",
			name: "Changelog",
			icon: IconLucideBell,
		},
	];
	const accountName = createMemo(() => {
		if (!auth.data) return "Signed Out";

		const name = userProfile.data?.name?.trim();
		if (name) return name;

		const email = userProfile.data?.email?.trim();
		if (email) return email;

		return "Signed In";
	});
	const accountImageUrl = createMemo(() => {
		const imageUrl = userProfile.data?.imageUrl?.trim();
		return imageUrl || null;
	});
	const accountLoading = createMemo(
		() =>
			auth.isLoading ||
			(!!auth.data && userProfile.isLoading && !userProfile.data),
	);
	const openDashboard = () => {
		void shell.open(
			new URL("/dashboard", clientEnv.VITE_SERVER_URL).toString(),
		);
	};

	const handleAuth = async () => {
		if (auth.data) {
			trackEvent("user_signed_out", { platform: "desktop" });
			authStore.set(undefined);
		}
	};

	const checkForUpdates = async () => {
		setIsCheckingForUpdates(true);

		try {
			const update = await check();

			if (!update) {
				await dialog.message(
					"You're already using the latest version of Cap.",
					{
						title: "No Update Available",
						kind: "info",
					},
				);
				return;
			}

			const shouldUpdate = await dialog.confirm(
				`Version ${update.version} of Cap is available, would you like to install it?`,
				{ title: "Update Cap", okLabel: "Update", cancelLabel: "Ignore" },
			);

			if (shouldUpdate) navigate("/update");
		} catch (e) {
			console.error("Failed to check for updates:", e);
			await dialog.message(
				"Unable to check for updates. Please download the latest version manually from cap.so/download. Your data will not be lost.\n\nIf this issue persists, please contact support.",
				{ title: "Update Error", kind: "error" },
			);
		} finally {
			setIsCheckingForUpdates(false);
		}
	};

	return (
		<div class="cap-settings-shell flex-1 flex flex-row divide-x divide-gray-3 text-[0.875rem] leading-5 overflow-y-hidden">
			<div
				class="cap-settings-sidebar flex flex-col h-full bg-gray-2"
				data-tauri-drag-region
			>
				<div class="cap-settings-window-spacer" data-tauri-drag-region />
				<button
					type="button"
					class="cap-settings-profile flex gap-2 items-center mx-2 mt-2 mb-3 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-gray-3"
					data-tauri-drag-region="false"
					onClick={openDashboard}
				>
					<Show
						when={!accountLoading()}
						fallback={
							<>
								<div class="cap-settings-profile-icon cap-settings-profile-skeleton cap-settings-profile-skeleton-avatar size-8 shrink-0 rounded-full bg-gray-4 animate-pulse" />
								<div class="cap-settings-profile-copy flex flex-col flex-1 gap-1.5 min-w-0">
									<span class="cap-settings-profile-skeleton cap-settings-profile-skeleton-title block h-3 w-24 rounded-full bg-gray-4 animate-pulse" />
									<span class="cap-settings-profile-skeleton cap-settings-profile-skeleton-subtitle block h-2.5 w-12 rounded-full bg-gray-4 animate-pulse" />
								</div>
							</>
						}
					>
						<Show
							when={accountImageUrl()}
							fallback={
								<div class="cap-settings-profile-icon flex justify-center items-center size-8 shrink-0 rounded-full bg-gray-3 text-gray-11">
									<IconLucideUserRound class="size-4" aria-hidden="true" />
								</div>
							}
						>
							{(imageUrl) => (
								<img
									class="cap-settings-profile-image size-8 shrink-0 rounded-full object-cover bg-gray-3"
									src={imageUrl()}
									alt=""
									draggable={false}
								/>
							)}
						</Show>
						<div class="cap-settings-profile-copy flex flex-col flex-1 gap-0.5 min-w-0">
							<p class="truncate text-[13px] text-gray-12">{accountName()}</p>
							<p class="truncate text-[11px] text-gray-10">Account</p>
						</div>
					</Show>
				</button>
				<ul class="cap-settings-nav min-w-48 h-full p-2.5 space-y-1 text-gray-12">
					<For each={settingsItems}>
						{(item) => (
							<li>
								<A
									href={item.href}
									activeClass="bg-gray-5 pointer-events-none"
									class="cap-settings-nav-item rounded-lg h-8 hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-1.5 transition-colors"
								>
									<item.icon class="opacity-60 size-4" aria-hidden="true" />
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
				</ul>
				<div class="cap-settings-account p-2.5 text-left flex flex-col">
					<Show when={version()}>
						{(v) => (
							<div class="mb-2 text-xs text-gray-11 flex flex-col items-start gap-1.5">
								<span>v{v()}</span>
								<div class="flex flex-col items-start gap-1.5">
									<button
										type="button"
										class="text-gray-11 hover:text-gray-12 underline transition-colors"
										onClick={() =>
											shell.open("https://cap.so/download/versions")
										}
									>
										View previous versions
									</button>
									<button
										type="button"
										class="text-gray-11 hover:text-gray-12 underline transition-colors disabled:cursor-default disabled:opacity-50 disabled:hover:text-gray-11"
										disabled={isCheckingForUpdates()}
										onClick={checkForUpdates}
									>
										{isCheckingForUpdates()
											? "Checking..."
											: "Check for updates"}
									</button>
								</div>
							</div>
						)}
					</Show>
					{auth.data ? (
						<Button
							onClick={handleAuth}
							variant={auth.data ? "gray" : "dark"}
							class="w-full"
						>
							Sign Out
						</Button>
					) : (
						<SignInButton>Sign In</SignInButton>
					)}
				</div>
			</div>
			<div class="cap-settings-content overflow-y-hidden flex-1 animate-in min-w-0">
				<CapErrorBoundary>
					<Suspense>{props.children}</Suspense>
				</CapErrorBoundary>
			</div>
		</div>
	);
}
