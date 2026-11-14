import { closeMainWindow, showHUD } from "@raycast/api";
import { triggerCapAction } from "./utils";

export default async function Command() {
	await closeMainWindow();

	try {
		await triggerCapAction({ open_settings: { page: null } });
		await showHUD("⚙️ Opening Cap Settings...");
	} catch {
		await showHUD("⚠️ Failed to open Cap Settings.");
	}
}
