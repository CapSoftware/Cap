import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
	await closeMainWindow();
	try {
		await open("cap://pause-recording");
		await showHUD("Pausing recording…");
	} catch {
		await showHUD("Failed to open Cap");
	}
}
