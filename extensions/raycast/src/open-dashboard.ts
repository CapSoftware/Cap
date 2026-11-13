import { closeMainWindow, open, showHUD } from "@raycast/api";
import { getConfiguredDashboardUrl } from "./utils";

export default async function Command() {
	await closeMainWindow();

	const dashboardUrl = getConfiguredDashboardUrl();
	try {
		await open(dashboardUrl);
		await showHUD("🌐 Opening Cap Dashboard...");
	} catch {
		await showHUD("⚠️ Failed to open Cap Dashboard.");
	}
}
