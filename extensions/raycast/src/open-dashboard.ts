import {
	closeMainWindow,
	getPreferenceValues,
	open,
	showHUD,
	showToast,
	Toast,
} from "@raycast/api";
import type { ExtensionPreferences } from "./types";
import { readCapDesktopStore, resolveDashboardUrl } from "./utils";

export default async function Command() {
	const preferences = getPreferenceValues<ExtensionPreferences>();

	try {
		const store = readCapDesktopStore();
		const dashboardUrl = resolveDashboardUrl(preferences, store);
		await closeMainWindow();
		await open(dashboardUrl);
		await showHUD("Opened Cap Dashboard");
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Could not open the Cap dashboard.";
		await showToast({
			style: Toast.Style.Failure,
			title: "Failed to open Cap Dashboard",
			message,
		});
	}
}
