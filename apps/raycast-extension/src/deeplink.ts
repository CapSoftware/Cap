export type RecordingMode = "instant" | "studio"

export interface StartRecordingPreferences {
    defaultMode?: RecordingMode
    defaultScreen?: string
    cameraDeviceId?: string
    micLabel?: string
    captureSystemAudio?: boolean
}

export interface StopRecordingPreferences {
    copyUrlOnStop?: boolean
    dashboardUrl?: string
}

export interface DeepLinkStartPayload {
    start_recording: {
        capture_mode: { screen: string } | { window: string }
        camera: { DeviceID: string } | null
        mic_label: string | null
        capture_system_audio: boolean
        mode: RecordingMode
    }
}

const CAP_ACTION_BASE_URL = "cap-desktop://action"
const DEFAULT_DASHBOARD_URL = "https://cap.so/dashboard"

// Builds the serialized DeepLinkStartPayload matching apps/desktop-gpui/src/deeplink.rs.
export function buildStartRecordingPayload(
    prefs: StartRecordingPreferences
): DeepLinkStartPayload {
    const screenName = (prefs.defaultScreen || "Primary").trim() || "Primary"
    const cameraId = prefs.cameraDeviceId?.trim()
    const micName = prefs.micLabel?.trim()

    return {
        start_recording: {
            capture_mode: { screen: screenName },
            camera: cameraId ? { DeviceID: cameraId } : null,
            mic_label: micName || null,
            capture_system_audio: prefs.captureSystemAudio ?? true,
            mode: prefs.defaultMode || "instant",
        },
    }
}

// Encodes a Cap desktop deep-link action into a cap-desktop://action?value=... URL.
export function encodeCapActionUrl(actionValue: unknown): string {
    const serialized = JSON.stringify(actionValue)
    return `${CAP_ACTION_BASE_URL}?value=${encodeURIComponent(serialized)}`
}

// Builds the cap-desktop:// deep link URL to start recording with user preferences.
export function buildStartRecordingDeepLink(
    prefs: StartRecordingPreferences = {}
): string {
    return encodeCapActionUrl(buildStartRecordingPayload(prefs))
}

// Builds the cap-desktop:// deep link URL to stop an active recording.
export function buildStopRecordingDeepLink(): string {
    return encodeCapActionUrl("stop_recording")
}

// Resolves and normalizes the Cap web dashboard URL from extension preferences.
export function resolveDashboardUrl(customUrl?: string): string {
    const trimmed = customUrl?.trim()
    if (!trimmed) {
        return DEFAULT_DASHBOARD_URL
    }
    return trimmed.replace(/\/+$/, "")
}

// Extracts a Cap shareable video link from clipboard text if one was published on stop.
export function extractShareableCapUrl(
    clipboardText: string | undefined,
    dashboardBaseUrl?: string
): string | null {
    if (!clipboardText) {
        return null
    }
    const trimmed = clipboardText.trim()
    const customOrigin = resolveDashboardUrl(dashboardBaseUrl).replace(
        /\/dashboard$/,
        ""
    )
    const isCapLink =
        trimmed.startsWith("https://cap.so/s/") ||
        trimmed.startsWith("https://cap.link/") ||
        (customOrigin.startsWith("http") &&
            trimmed.startsWith(`${customOrigin}/s/`))

    return isCapLink ? trimmed : null
}
