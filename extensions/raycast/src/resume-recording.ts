import { open, showHUD } from "@raycast/api";

export default async function Command() {
	try {
		await open("cap://resume");
		await showHUD("Resuming Cap recording...");
	} catch (_error) {
		await showHUD("Failed to open Cap");
	}
}
