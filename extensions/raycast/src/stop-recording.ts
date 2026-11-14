import { closeMainWindow, showHUD } from "@raycast/api";
import { triggerCapAction } from "./utils";

export default async function Command() {
	await closeMainWindow();

	try {
		await triggerCapAction("stop_recording");
		await showHUD("⏹️ Stopping Cap recording (link copied in Instant mode)...");
	} catch {
		await showHUD("⚠️ Failed to stop Cap recording.");
	}
}
