import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { onCleanup, onMount } from "solid-js";
import ModeSelect from "~/components/ModeSelect";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";
import { initializeTitlebar } from "~/utils/titlebar-state";

const ModeSelectWindow = () => {
	let unlistenResize: UnlistenFn | undefined;
	const isWindows = ostype() === "windows";

	onMount(async () => {
		const window = getCurrentWindow();

		if (isWindows) {
			try {
				unlistenResize = await initializeTitlebar();
			} catch (error) {
				console.error("Failed to initialize titlebar:", error);
			}
		}

		try {
			const currentSize = await window.innerSize();

			if (currentSize.width !== 900 || currentSize.height !== 500) {
				await window.setSize(new LogicalSize(900, 500));
			}
		} catch (error) {
			console.error("Failed to set window size:", error);
		}
	});

	onCleanup(() => {
		unlistenResize?.();
	});

	return (
		<div
			data-tauri-drag-region
			class="flex relative justify-center items-center p-4 min-h-screen bg-gray-1"
		>
			{isWindows && (
				<div class="absolute top-0 right-0 z-50 h-9">
					<CaptionControlsWindows11 />
				</div>
			)}
			<div
				data-tauri-drag-region="none"
				class="relative z-10 space-y-10 w-full max-w-5xl"
			>
				<h2 class="text-[24px] font-medium text-center text-gray-12">
					Recording Modes
				</h2>
				<ModeSelect />
			</div>
		</div>
	);
};

export default ModeSelectWindow;
