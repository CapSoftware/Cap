/**
 * Utility functions for constructing and triggering Cap deeplinks
 */

export interface CaptureTarget {
    display?: { id: string };
    window?: { id: string };
}

export interface DeviceOrModelID {
    Device?: string;
    ModelID?: string;
}

/**
 * Builds a Cap deeplink URL from an action object
 */
export function buildDeeplinkURL(action: Record<string, any>): string {
    const jsonValue = JSON.stringify(action);
    const encodedValue = encodeURIComponent(jsonValue);
    return `cap-desktop://action?value=${encodedValue}`;
}

/**
 * Opens a Cap deeplink URL
 */
export async function triggerDeeplink(action: Record<string, any>): Promise<void> {
    const url = buildDeeplinkURL(action);
    const { open } = await import("@raycast/api");
    await open(url);
}

/**
 * Start recording deeplink
 */
export async function startRecording(options: {
    captureMode: { screen: string } | { window: string };
    camera?: DeviceOrModelID | null;
    micLabel?: string | null;
    captureSystemAudio?: boolean;
    mode?: "Studio" | "Instant";
}): Promise<void> {
    const action = {
        startRecording: {
            captureMode: options.captureMode,
            camera: options.camera ?? null,
            micLabel: options.micLabel ?? null,
            captureSystemAudio: options.captureSystemAudio ?? false,
            mode: options.mode ?? "Studio",
        },
    };
    await triggerDeeplink(action);
}

/**
 * Stop recording deeplink
 */
export async function stopRecording(): Promise<void> {
    await triggerDeeplink({ stopRecording: {} });
}

/**
 * Pause recording deeplink
 */
export async function pauseRecording(): Promise<void> {
    await triggerDeeplink({ pauseRecording: {} });
}

/**
 * Resume recording deeplink
 */
export async function resumeRecording(): Promise<void> {
    await triggerDeeplink({ resumeRecording: {} });
}

/**
 * Toggle pause recording deeplink
 */
export async function togglePauseRecording(): Promise<void> {
    await triggerDeeplink({ togglePauseRecording: {} });
}

/**
 * Take screenshot deeplink
 */
export async function takeScreenshot(captureTarget: CaptureTarget): Promise<void> {
    const action = {
        takeScreenshot: {
            captureTarget,
        },
    };
    await triggerDeeplink(action);
}

/**
 * Set camera deeplink
 */
export async function setCamera(id: DeviceOrModelID | null): Promise<void> {
    await triggerDeeplink({ setCamera: { id } });
}

/**
 * Set microphone deeplink
 */
export async function setMicrophone(label: string | null): Promise<void> {
    await triggerDeeplink({ setMicrophone: { label } });
}

/**
 * List cameras deeplink (output goes to console)
 */
export async function listCameras(): Promise<void> {
    await triggerDeeplink({ listCameras: {} });
}

/**
 * List microphones deeplink (output goes to console)
 */
export async function listMicrophones(): Promise<void> {
    await triggerDeeplink({ listMicrophones: {} });
}

/**
 * List displays deeplink (output goes to console)
 */
export async function listDisplays(): Promise<void> {
    await triggerDeeplink({ listDisplays: {} });
}

/**
 * List windows deeplink (output goes to console)
 */
export async function listWindows(): Promise<void> {
    await triggerDeeplink({ listWindows: {} });
}
