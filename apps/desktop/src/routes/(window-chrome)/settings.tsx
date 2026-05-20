import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps, useNavigate } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import * as dialog from "@tauri-apps/plugin-dialog";
import * as shell from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import "@total-typescript/ts-reset/filter-boolean";
import { createResource, createSignal, For, Show, Suspense } from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import { SignInButton } from "~/components/SignInButton";

import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";

export default function Settings(props: RouteSectionProps) {
	const navigate = useNavigate();
	const auth = authStore.createQuery();
	const [version] = createResource(() => getVersion());
	const [isCheckingForUpdates, setIsCheckingForUpdates] = createSignal(false);

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
		<div class="flex-1 flex flex-row divide-x divide-gray-3 text-[0.875rem] leading-5 overflow-y-hidden">
			<div class="flex flex-col h-full bg-gray-2">
				<ul class="min-w-48 h-full p-2.5 space-y-1 text-gray-12">
					<For
						each={[
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
						].filter(Boolean)}
					>
						{(item) => (
							<li>
								<A
									href={item.href}
									activeClass="bg-gray-5 pointer-events-none"
									class="rounded-lg h-8 hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-1.5 transition-colors"
								>
									<item.icon class="opacity-60 size-4" />
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
				</ul>
				<div class="p-2.5 text-left flex flex-col">
					<Show when={version()}>
						{(v) => (
							<div class="mb-2 text-xs text-gray-11 flex flex-col items-start gap-0.5">
								<span>v{v()}</span>
								<div class="flex flex-col items-start gap-0.5">
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
			<div class="overflow-y-hidden flex-1 animate-in">
				<CapErrorBoundary>
					<Suspense>{props.children}</Suspense>
				</CapErrorBoundary>
			</div>
		</div>
	);
}
