import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { type as ostype } from "@tauri-apps/plugin-os";
import { onMount } from "solid-js";
import ModeSelect from "~/components/ModeSelect";
import CaptionControlsWindows11 from "~/components/titlebar/controls/CaptionControlsWindows11";

const ModeSelectWindow = () => {
	const isWindows = ostype() === "windows";

	onMount(async () => {
		const window = getCurrentWindow();

		try {
			const currentSize = await window.innerSize();

			if (currentSize.width !== 580 || currentSize.height !== 340) {
				await window.setSize(new LogicalSize(580, 340));
			}
		} catch (error) {
			console.error("Failed to set window size:", error);
		}
	});

	return (
		<div
			data-tauri-drag-region
			class="flex flex-col relative justify-center items-center min-h-screen bg-gray-1"
		>
			{isWindows && (
				<div class="absolute top-0 right-0 z-50 h-9">
					<CaptionControlsWindows11 />
				</div>
			)}

			<div class="flex flex-col items-center w-full px-6 py-5">
				<div class="mb-5 text-center">
					<h2 class="text-xl font-semibold text-gray-12 mb-1">
						Choose Recording Mode
					</h2>
					<p class="text-sm text-gray-11">
						Select how you want to capture your screen
					</p>
				</div>

				<div data-tauri-drag-region="false" class="w-full max-w-lg">
					<ModeSelect />
				</div>
			</div>
		</div>
	);
};

export default ModeSelectWindow;
