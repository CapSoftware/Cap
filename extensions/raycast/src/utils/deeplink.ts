import { open, showHUD } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop://action";

type DeepLinkAction =
  | { stop_recording: Record<string, never> }
  | { pause_recording: Record<string, never> }
  | { resume_recording: Record<string, never> }
  | { toggle_pause_recording: Record<string, never> }
  | { restart_recording: Record<string, never> }
  | { set_microphone: { label: string | null } }
  | { set_camera: { id: string | null } }
  | { open_settings: { page: string | null } };

export async function executeDeepLink(action: DeepLinkAction, successMessage: string): Promise<void> {
  const jsonValue = JSON.stringify(action);
  const encodedValue = encodeURIComponent(jsonValue);
  const deeplink = `${DEEPLINK_SCHEME}?value=${encodedValue}`;

  try {
    await open(deeplink);
    await showHUD(successMessage);
  } catch {
    await showHUD("Failed to communicate with Cap. Is it running?");
  }
}

export async function stopRecording(): Promise<void> {
  await executeDeepLink({ stop_recording: {} }, "⏹ Recording stopped");
}

export async function pauseRecording(): Promise<void> {
  await executeDeepLink({ pause_recording: {} }, "⏸ Recording paused");
}

export async function resumeRecording(): Promise<void> {
  await executeDeepLink({ resume_recording: {} }, "▶️ Recording resumed");
}

export async function togglePauseRecording(): Promise<void> {
  await executeDeepLink({ toggle_pause_recording: {} }, "⏯ Toggled pause");
}

export async function restartRecording(): Promise<void> {
  await executeDeepLink({ restart_recording: {} }, "🔄 Recording restarted");
}

export async function setMicrophone(label: string | null): Promise<void> {
  await executeDeepLink({ set_microphone: { label } }, label ? `🎤 Switched to ${label}` : "🎤 Microphone disabled");
}

export async function setCamera(id: string | null): Promise<void> {
  await executeDeepLink({ set_camera: { id } }, id ? `📷 Camera switched` : "📷 Camera disabled");
}

export async function openSettings(page?: string): Promise<void> {
  await executeDeepLink({ open_settings: { page: page ?? null } }, "⚙️ Opening settings");
}
