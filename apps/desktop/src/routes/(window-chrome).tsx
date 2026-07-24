import { type RouteSectionProps, useLocation } from "@solidjs/router";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { cx } from "cva";
import {
	createEffect,
	onCleanup,
	onMount,
	type ParentProps,
	Suspense,
} from "solid-js";

import { AbsoluteInsetLoader } from "~/components/Loader";
import CaptionControlsMacOS from "~/components/titlebar/controls/CaptionControlsMacOS";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { applyMacOSWindowMaterial } from "~/utils/macos-window-material";
import { initializeTitlebar } from "~/utils/titlebar-state";
import {
	useWindowChromeContext,
	WindowChromeContext,
} from "./(window-chrome)/Context";

export default function (props: RouteSectionProps) {
	let unlistenResize: UnlistenFn | undefined;
	const location = useLocation();

	onMount(async () => {
		console.log("window chrome mounted");
		void initializeTitlebar().then((unlisten) => {
			unlistenResize = unlisten;
		});
	});

	const handleKeyDown = (e: KeyboardEvent) => {
		const isMac = ostype() === "macos";
		const closeShortcut = isMac
			? e.metaKey && e.key === "w"
			: e.ctrlKey && e.key === "w";

		if (closeShortcut) {
			e.preventDefault();
			getCurrentWindow().close();
		}
	};

	onMount(() => {
		window.addEventListener("keydown", handleKeyDown);
	});

	onCleanup(() => {
		unlistenResize?.();
		window.removeEventListener("keydown", handleKeyDown);
	});

	const isMacOS = ostype() === "macos";

	createEffect(() => {
		void applyMacOSWindowMaterial(
			location.pathname.startsWith("/settings") ? "settings" : "panel",
		).catch((error) => {
			console.error("Failed to apply macOS window material:", error);
		});
	});

	return (
		<WindowChromeContext>
			<div
				class={cx(
					"cap-window-shell flex overflow-hidden flex-col w-screen h-screen max-h-screen divide-y divide-gray-5 bg-gray-1",
					isMacOS && "rounded-[16px]",
				)}
			>
				<Header />

				{/* breaks sometimes */}
				{/* <Transition
        mode="outin"
        enterActiveClass="transition-opacity duration-100"
        exitActiveClass="transition-opacity duration-100"
        enterClass="opacity-0"
        exitToClass="opacity-0"
        > */}
				<Suspense fallback={<AbsoluteInsetLoader />}>
					<Inner>
						<Suspense fallback={null}>{props.children}</Suspense>
					</Inner>
				</Suspense>
				{/* </Transition> */}
			</div>
		</WindowChromeContext>
	);
}

function Header() {
	const ctx = useWindowChromeContext();
	const location = useLocation();
	if (!ctx)
		throw new Error(
			"useWindowChrome must be used within a WindowChromeContext",
		);

	const isWindows = ostype() === "windows";
	const isMacOS = ostype() === "macos";
	const isLinux = ostype() === "linux";
	const isSettings = () => location.pathname.startsWith("/settings");

	if (isMacOS && isSettings()) return null;

	return (
		<header
			class={cx(
				"cap-window-header flex items-center min-w-0 w-full h-9 select-none shrink-0 bg-gray-2",
				isWindows ? "flex-row" : "flex-row-reverse",
			)}
			data-tauri-drag-region
		>
			{ctx.state()?.items}
			{isWindows && (
				<CaptionControlsWindows11
					class="ml-auto!"
					maximizable={ctx.state()?.onMaximize ? true : undefined}
					maximized={ctx.state()?.maximized}
					onMaximize={ctx.state()?.onMaximize}
				/>
			)}
			{((isMacOS && !isSettings()) || isLinux) && (
				<CaptionControlsMacOS
					class="mr-auto! ml-3"
					showMinimize={false}
					showZoom={ctx.state()?.onMaximize !== undefined}
					onZoom={ctx.state()?.onMaximize}
				/>
			)}
		</header>
	);
}

function Inner(props: ParentProps) {
	const location = useLocation();

	onMount(() => {
		if (location.pathname !== "/") void getCurrentWindow().show();
	});

	return (
		<div
			data-tauri-drag-region="false"
			class="cap-window-body flex overflow-hidden flex-col flex-1"
		>
			{props.children}
		</div>
	);
}
