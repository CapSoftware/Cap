import { closeMainWindow, getPreferenceValues, open, showHUD } from "@raycast/api";

interface Preferences {
	captureMode?: "fullscreen" | "window" | "area";
}

export default async function Command() {
	const { captureMode = "fullscreen" } = getPreferenceValues<Preferences>();
	await closeMainWindow();
	await open(`cap://start-recording?mode=${encodeURIComponent(captureMode)}`);
	await showHUD(`Cap recording started (${captureMode})`);
}
