import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { onMount } from "solid-js";
import ModeSelect from "~/components/ModeSelect";

const ModeSelectWindow = () => {
	onMount(async () => {
		const window = getCurrentWindow();
		try {
			const currentSize = await window.innerSize();

			if (currentSize.width !== 900 || currentSize.height !== 500) {
				await window.setSize(new LogicalSize(900, 500));
			}
		} catch (error) {
			console.error("Failed to set window size:", error);
		}
	});

	return (
		<div
			data-tauri-drag-region
			class="flex relative justify-center items-center p-4 min-h-screen bg-gray-1"
		>
			<div class="relative z-10 space-y-10 w-full max-w-3xl">
				<h2 class="text-[24px] font-medium text-center text-gray-12">
					Recording Modes
				</h2>
				<ModeSelect />
			</div>
		</div>
	);
};

export default ModeSelectWindow;
