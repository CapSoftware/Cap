import { closeMainWindow, getPreferenceValues, open } from "@raycast/api";

interface Preferences {
	dashboardUrl?: string;
}

export default async function Command() {
	const { dashboardUrl = "https://cap.so/dashboard" } = getPreferenceValues<Preferences>();
	const targetUrl = dashboardUrl.trim() || "https://cap.so/dashboard";
	await closeMainWindow();
	await open(targetUrl);
}
