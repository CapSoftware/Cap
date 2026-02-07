import { open, showHUD } from "@raycast/api";

export default async function Command() {
	try {
		await open("cap://pause");
		await showHUD("Pausing Cap recording...");
	} catch (_error) {
		await showHUD("Failed to open Cap");
	}
}
