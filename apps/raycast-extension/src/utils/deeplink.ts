export interface CaptureTarget {
    display?: { id: string };
    window?: { id: string };
}

export interface DeviceOrModelID {
    Device?: string;
    ModelID?: string;
}

export function buildDeeplinkURL(action: Record<string, any>): string {
    const jsonValue = JSON.stringify(action);
    const encodedValue = encodeURIComponent(jsonValue);
    return `cap-desktop://action?value=${encodedValue}`;
}

export async function triggerDeeplink(action: Record<string, any>): Promise<void> {
    const url = buildDeeplinkURL(action);
    const { open } = await import("@raycast/api");
    await open(url);
}

export async function startRecording(options: {
    captureMode: { screen: string } | { window: string };
    camera?: DeviceOrModelID | null;
    micLabel?: string | null;
    captureSystemAudio?: boolean;
    mode?: "Studio" | "Instant";
}): Promise<void> {
    const action = {
        start_recording: {
            capture_mode: options.captureMode,
            camera: options.camera ?? null,
            mic_label: options.micLabel ?? null,
            capture_system_audio: options.captureSystemAudio ?? false,
            mode: options.mode ?? "Studio",
        },
    };
    await triggerDeeplink(action);
}

export async function stopRecording(): Promise<void> {
    await triggerDeeplink({ stop_recording: {} });
}

export async function pauseRecording(): Promise<void> {
    await triggerDeeplink({ pause_recording: {} });
}

export async function resumeRecording(): Promise<void> {
    await triggerDeeplink({ resume_recording: {} });
}

export async function togglePauseRecording(): Promise<void> {
    await triggerDeeplink({ toggle_pause_recording: {} });
}

export async function takeScreenshot(captureTarget: CaptureTarget): Promise<void> {
    const action = {
        take_screenshot: {
            capture_target: captureTarget,
        },
    };
    await triggerDeeplink(action);
}

export async function setCamera(id: DeviceOrModelID | null): Promise<void> {
    await triggerDeeplink({ set_camera: { id } });
}

export async function setMicrophone(label: string | null): Promise<void> {
    await triggerDeeplink({ set_microphone: { label } });
}

export async function listCameras(): Promise<void> {
    await triggerDeeplink({ list_cameras: {} });
}

export async function listMicrophones(): Promise<void> {
    await triggerDeeplink({ list_microphones: {} });
}

export async function listDisplays(): Promise<void> {
    await triggerDeeplink({ list_displays: {} });
}

export async function listWindows(): Promise<void> {
    await triggerDeeplink({ list_windows: {} });
}
