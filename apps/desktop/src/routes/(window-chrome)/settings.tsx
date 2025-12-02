import { A, type RouteSectionProps, useLocation } from "@solidjs/router";
import { createEffect, createSignal, For, onMount, Suspense } from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import IconCapSettings from "~icons/cap/settings";
import IconCapHotkeys from "~icons/cap/hotkeys";
import IconLucideSquarePlay from "~icons/lucide/square-play";

const TABS = [
	{
		href: "general",
		name: "Settings",
		icon: IconCapSettings,
	},
	{
		href: "hotkeys",
		name: "Shortcuts",
		icon: IconCapHotkeys,
	},
	{
		href: "recordings",
		name: "Previous Recordings",
		icon: IconLucideSquarePlay,
	},
];

export default function Settings(props: RouteSectionProps) {
	const location = useLocation();
	const [indicatorStyle, setIndicatorStyle] = createSignal<{
		left: string;
		width: string;
	}>({ left: "0px", width: "0px" });
	let tabRefs: HTMLAnchorElement[] = [];

	const updateIndicator = () => {
		const currentPath = location.pathname.split("/").pop();
		const activeIndex = TABS.findIndex((tab) => tab.href === currentPath);

		if (activeIndex !== -1 && tabRefs[activeIndex]) {
			const activeTab = tabRefs[activeIndex];
			const parentRect = activeTab.parentElement?.parentElement?.getBoundingClientRect();
			const tabRect = activeTab.getBoundingClientRect();

			if (parentRect) {
				setIndicatorStyle({
					left: `${tabRect.left - parentRect.left}px`,
					width: `${tabRect.width}px`,
				});
			}
		}
	};

	onMount(() => {
		updateIndicator();
	});

	createEffect(() => {
		location.pathname;
		updateIndicator();
	});

	return (
		<div class="flex-1 flex flex-col text-[0.875rem] leading-[1.25rem] overflow-y-hidden ">
			<div class="flex flex-col border-b border-gray-3 h-10 my-4">
				<ul class="flex flex-row gap-5 text-gray-12 relative">
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
									ref={(el) => (tabRefs[index()] = el)}
									href={item.href}
									activeClass="text-white"
									inactiveClass="text-white/40 hover:text-white/80"
									class="flex flex-row items-center gap-[0.375rem] h-[2.5rem] font-medium text-[14px] transition-colors relative z-10"
								>
									{/* <item.icon class="opacity-60 size-4" /> */}
									<span>{item.name}</span>
								</A>
							</li>
						)}
					</For>
					<div
						class="absolute bottom-0 h-[2px] bg-blue-9 transition-all duration-200 ease-out pointer-events-none"
						style={{
							left: indicatorStyle().left,
							width: indicatorStyle().width,
						}}
					/>
				</ul>
			</div>
			<div class="overflow-y-auto flex-1 animate-in">
				<CapErrorBoundary>
					<Suspense>{props.children}</Suspense>
				</CapErrorBoundary>
			</div>
		</div>
	);
}

// import { Button } from "@cap/ui-solid";
// import { A, type RouteSectionProps } from "@solidjs/router";
// import { getVersion } from "@tauri-apps/api/app";
// import "@total-typescript/ts-reset/filter-boolean";
// import { createResource, For, Show, Suspense } from "solid-js";
// import { CapErrorBoundary } from "~/components/CapErrorBoundary";
// import { SignInButton } from "~/components/SignInButton";

// import { authStore } from "~/store";
// import { trackEvent } from "~/utils/analytics";

// export default function Settings(props: RouteSectionProps) {
// 	const auth = authStore.createQuery();
// 	const [version] = createResource(() => getVersion());

// const handleAuth = async () => {
// 	if (auth.data) {
// 		trackEvent("user_signed_out", { platform: "desktop" });
// 		authStore.set(undefined);
// 	}
// };

// 	return (
// 		<div class="flex-1 flex flex-row divide-x divide-gray-3 text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
// 			<div class="flex flex-col h-full bg-gray-2">
// 				<ul class="min-w-[12rem] h-full p-[0.625rem] space-y-1 text-gray-12">
// 					<For
// 						each={[
// 							{
// 								href: "general",
// 								name: "General",
// 								icon: IconCapSettings,
// 							},
// 							{
// 								href: "hotkeys",
// 								name: "Shortcuts",
// 								icon: IconCapHotkeys,
// 							},
// 							{
// 								href: "recordings",
// 								name: "Previous Recordings",
// 								icon: IconLucideSquarePlay,
// 							},
// 							{
// 								href: "integrations",
// 								name: "Integrations",
// 								icon: IconLucideUnplug,
// 							},
// 							{
// 								href: "license",
// 								name: "License",
// 								icon: IconLucideGift,
// 							},
// 							{
// 								href: "experimental",
// 								name: "Experimental",
// 								icon: IconCapSettings,
// 							},
// 							{
// 								href: "feedback",
// 								name: "Feedback",
// 								icon: IconLucideMessageSquarePlus,
// 							},
// 							{
// 								href: "changelog",
// 								name: "Changelog",
// 								icon: IconLucideBell,
// 							},
// 						].filter(Boolean)}
// 					>
// 						{(item) => (
// 							<li>
// 								<A
// 									href={item.href}
// 									activeClass="bg-gray-5 pointer-events-none"
// 									class="rounded-lg h-[2rem] hover:bg-gray-3 text-[13px] px-2 flex flex-row items-center gap-[0.375rem] transition-colors"
// 								>
// 									<item.icon class="opacity-60 size-4" />
// 									<span>{item.name}</span>
// 								</A>
// 							</li>
// 						)}
// 					</For>
// 				</ul>
// 				<div class="p-[0.625rem] text-left flex flex-col">
// 					<Show when={version()}>
// 						{(v) => <p class="mb-2 text-xs text-gray-11">v{v()}</p>}
// 					</Show>
// {auth.data ? (
// 	<Button
// 		onClick={handleAuth}
// 		variant={auth.data ? "gray" : "dark"}
// 		class="w-full"
// 	>
// 		Sign Out
// 	</Button>
// ) : (
// 	<SignInButton>Sign In</SignInButton>
// )}
// 				</div>
// 			</div>
// 			<div class="overflow-y-hidden flex-1 animate-in">
// 				<CapErrorBoundary>
// 					<Suspense>{props.children}</Suspense>
// 				</CapErrorBoundary>
// 			</div>
// 		</div>
// 	);
// }
