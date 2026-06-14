import { open } from "@raycast/api";
import { RecordingMode, CaptureMode } from "./types";

const DEEP_LINK_SCHEME = "cap-desktop";

export function buildDeepLink(action: string, params?: Record<string, unknown>): string {
  const value = JSON.stringify({
    action,
    ...params,
  });
  return `${DEEP_LINK_SCHEME}://action?value=${encodeURIComponent(value)}`;
}

export async function sendDeepLink(action: string, params?: Record<string, unknown>): Promise<void> {
  const url = buildDeepLink(action, params);
  await open(url);
}

export function buildStartRecordingDeeplink(options: {
  mode: RecordingMode;
  captureMode: CaptureMode;
  screenName?: string;
  windowName?: string;
  cameraId?: string;
  micLabel?: string;
  captureSystemAudio?: boolean;
}): string {
  const capture_mode =
    options.captureMode === "screen" && options.screenName
      ? { Screen: options.screenName }
      : options.captureMode === "window" && options.windowName
      ? { Window: options.windowName }
      : { Screen: "Primary" };

  return buildDeepLink("start_recording", {
    capture_mode,
    camera: options.cameraId ? { DeviceID: options.cameraId } : null,
    mic_label: options.micLabel || null,
    capture_system_audio: options.captureSystemAudio ?? false,
    mode: options.mode,
  });
}
