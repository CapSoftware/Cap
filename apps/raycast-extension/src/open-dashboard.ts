import {
    closeMainWindow,
    getPreferenceValues,
    open,
    showHUD,
} from "@raycast/api"
import { StopRecordingPreferences, resolveDashboardUrl } from "./deeplink"

// Raycast command entry point to open the Cap web dashboard in the default browser.
export default async function Command(): Promise<void> {
    const prefs = getPreferenceValues<StopRecordingPreferences>()
    const targetUrl = resolveDashboardUrl(prefs.dashboardUrl)

    await closeMainWindow()
    await open(targetUrl)
    await showHUD("Opened Cap Dashboard")
}
