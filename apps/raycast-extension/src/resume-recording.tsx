import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
	await closeMainWindow();
	try {
		await open("cap://resume-recording");
		await showHUD("Resuming recording…");
	} catch {
		await showHUD("Failed to open Cap");
	}
}
