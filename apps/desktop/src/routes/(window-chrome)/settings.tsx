import { Button } from "@cap/ui-solid";
import { A, type RouteSectionProps, useLocation } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import "@total-typescript/ts-reset/filter-boolean";
import { createEffect, createResource, createSignal, For, onMount, Show, Suspense } from "solid-js";
import { CapErrorBoundary } from "~/components/CapErrorBoundary";
import { SignInButton } from "~/components/SignInButton";
import { authStore } from "~/store";
import { trackEvent } from "~/utils/analytics";

import IconCapSettings from "~icons/cap/settings";
import IconCapHotkeys from "~icons/cap/hotkeys";
import IconLucideSquarePlay from "~icons/lucide/square-play";
import IconLucideImage from "~icons/lucide/image";
import IconLucideUnplug from "~icons/lucide/unplug";
import IconLucideGift from "~icons/lucide/gift";
import IconLucideMessageSquarePlus from "~icons/lucide/message-square-plus";
import IconLucideBell from "~icons/lucide/bell";

const TABS = [
	{ href: "general", name: "General", icon: IconCapSettings },
	{ href: "hotkeys", name: "Shortcuts", icon: IconCapHotkeys },
	{ href: "recordings", name: "Recordings", icon: IconLucideSquarePlay },
];

export default function Settings(props: RouteSectionProps) {
	const location = useLocation();
	const auth = authStore.createQuery();
	const [version] = createResource(() => getVersion());
	const [indicatorStyle, setIndicatorStyle] = createSignal<{
		left: string;
		width: string;
	}>({ left: "0px", width: "0px" });
	let tabRefs: HTMLAnchorElement[] = [];

	const handleAuth = async () => {
		if (auth.data) {
			trackEvent("user_signed_out", { platform: "desktop" });
			authStore.set(undefined);
		}
	};

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
		<div class="flex-1 flex flex-col text-[0.875rem] leading-[1.25rem] overflow-y-hidden">
			<div class="flex flex-row items-center justify-between border-b border-gray-3 h-10 my-4">
				<ul class="flex flex-row gap-5 text-gray-12 relative">
					<For each={TABS}>
						{(item, index) => (
							<li>
								<A
									ref={(el) => (tabRefs[index()] = el)}
									href={item.href}
									activeClass="text-white"
									inactiveClass="text-white/40 hover:text-white/80"
									class="flex flex-row items-center gap-[0.375rem] h-[2.5rem] font-medium text-[14px] transition-colors relative z-10"
								>
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
