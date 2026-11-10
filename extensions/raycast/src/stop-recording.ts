import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
	await closeMainWindow();
	await open(`cap-desktop://action?value=${encodeURIComponent(JSON.stringify("stop_recording"))}`);
	await showHUD("Cap recording stopped");
}
