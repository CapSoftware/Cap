import {
    Clipboard,
    closeMainWindow,
    getPreferenceValues,
    open,
    showHUD,
} from "@raycast/api"
import {
    StartRecordingPreferences,
    buildStartRecordingDeepLink,
} from "./deeplink"

// Raycast command entry point to start a Cap recording with configured user defaults.
export default async function Command(): Promise<void> {
    const prefs = getPreferenceValues<StartRecordingPreferences>()
    const deepLinkUrl = buildStartRecordingDeepLink(prefs)

    await closeMainWindow()
    await open(deepLinkUrl)
    await showHUD(
        `Cap recording started (${prefs.defaultMode || "instant"} mode)`
    )
}

export { Clipboard }
