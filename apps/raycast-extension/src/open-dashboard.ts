import { type StopRecordingPreferences, resolveDashboardUrl } from "./deeplink";
import {
	closeMainWindow,
	getPreferenceValues,
	open,
	showHUD,
} from "./raycast-bridge";

export default async function Command(): Promise<void> {
	const prefs = await getPreferenceValues<StopRecordingPreferences>();
	const targetUrl = resolveDashboardUrl(prefs.dashboardUrl);

	await closeMainWindow();
	await open(targetUrl);
	await showHUD("Opened Cap Dashboard");
}
