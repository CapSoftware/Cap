import { closeMainWindow, showHUD } from "@raycast/api";
import { triggerCapAction } from "./utils";

export default async function Command() {
	await closeMainWindow();

	try {
		await triggerCapAction("stop_recording");
		await showHUD("⏹️ Stopping Cap recording...");
	} catch (error) {
		await showHUD("⚠️ Failed to stop Cap recording.");
	}
}
