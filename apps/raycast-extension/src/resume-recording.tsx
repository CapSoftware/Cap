import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
	await closeMainWindow();
	await open("cap://resume-recording");
	await showHUD("Resuming recording…");
}
