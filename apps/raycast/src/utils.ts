import { open, showHUD } from "@raycast/api";

export type DeepLinkAction =
  | { start_recording: { capture_mode: { screen: string } | { window: string }; camera?: string; mic_label?: string; capture_system_audio: boolean; mode: string } }
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "toggle_pause_recording"
  | "take_screenshot"
  | "list_displays"
  | "list_windows"
  | "list_cameras"
  | "list_microphones"
  | { open_editor: { project_path: string } }
  | { open_settings: { page?: string } };

export async function executeCapAction(action: DeepLinkAction): Promise<void> {
  const encodedValue = encodeURIComponent(JSON.stringify(action));
  const url = `cap-desktop://action?value=${encodedValue}`;

  try {
    await open(url);
  } catch (error) {
    await showHUD("Failed to connect to Cap. Is it running?");
    throw error;
  }
}

export async function startRecording(displayName: string, options?: { camera?: string; micLabel?: string; systemAudio?: boolean }): Promise<void> {
  await executeCapAction({
    start_recording: {
      capture_mode: { screen: displayName },
      camera: options?.camera,
      mic_label: options?.micLabel,
      capture_system_audio: options?.systemAudio ?? false,
      mode: "studio",
    },
  });
  await showHUD("Recording started");
}

export async function stopRecording(): Promise<void> {
  await executeCapAction("stop_recording");
  await showHUD("Recording stopped");
}

export async function pauseRecording(): Promise<void> {
  await executeCapAction("pause_recording");
  await showHUD("Recording paused");
}

export async function resumeRecording(): Promise<void> {
  await executeCapAction("resume_recording");
  await showHUD("Recording resumed");
}

export async function togglePause(): Promise<void> {
  await executeCapAction("toggle_pause_recording");
  await showHUD("Toggled pause");
}

export async function takeScreenshot(): Promise<void> {
  await executeCapAction("take_screenshot");
  await showHUD("Screenshot taken");
}

export async function openSettings(page?: string): Promise<void> {
  await executeCapAction({ open_settings: { page } });
}
