import { closeMainWindow, showHUD } from "@raycast/api";
import { triggerCapAction } from "./utils";

export default async function Command() {
	await closeMainWindow();

	const action = {
		start_recording: {
			capture_mode: {
				screen: "default",
			},
			camera: null,
			mic_label: null,
			capture_system_audio: true,
			mode: "instant",
		},
	};

	try {
		await triggerCapAction(action);
		await showHUD("🎥 Starting Cap recording...");
	} catch (error) {
		await showHUD(
			"⚠️ Failed to trigger Cap recording. Make sure Cap is running.",
		);
	}
}
