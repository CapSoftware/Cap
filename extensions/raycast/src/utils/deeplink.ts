export type DeeplinkAction =
  | { pause_recording: Record<string, never> }
  | { resume_recording: Record<string, never> }
  | { toggle_pause_recording: Record<string, never> }
  | { stop_recording: Record<string, never> }
  | { switch_microphone: { mic_label: string } }
  | { switch_camera: { camera: { device_id: string } } }
  | { list_microphones: Record<string, never> }
  | { list_cameras: Record<string, never> };

export function buildDeeplink(action: DeeplinkAction): string {
  const json = JSON.stringify(action);
  const encoded = encodeURIComponent(json);
  return `cap-desktop://action?value=${encoded}`;
}
