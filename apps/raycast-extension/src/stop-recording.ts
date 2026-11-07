import {
    Clipboard,
    closeMainWindow,
    getPreferenceValues,
    open,
    showHUD,
} from "@raycast/api"
import {
    StopRecordingPreferences,
    buildStopRecordingDeepLink,
    extractShareableCapUrl,
} from "./deeplink"

// Raycast command entry point to stop the current Cap recording and copy the share URL.
export default async function Command(): Promise<void> {
    const prefs = getPreferenceValues<StopRecordingPreferences>()
    const deepLinkUrl = buildStopRecordingDeepLink()

    await closeMainWindow()
    await open(deepLinkUrl)

    if (prefs.copyUrlOnStop ?? true) {
        const existingText = await Clipboard.readText()
        const shareUrl = extractShareableCapUrl(
            existingText,
            prefs.dashboardUrl
        )
        if (shareUrl) {
            await Clipboard.copy(shareUrl)
            await showHUD(`Cap recording stopped — copied ${shareUrl}`)
            return
        }
    }

    await showHUD("Cap recording stopped")
}
