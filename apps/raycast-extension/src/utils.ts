import { getPreferenceValues } from "@raycast/api";

interface Preferences {
  captureMode: string;
  recordingMode: string;
  captureSystemAudio: boolean;
}

export function getPreferences(): Preferences {
  return getPreferenceValues<Preferences>();
}

export function buildDeeplink(action: string, value: unknown): string {
  const json = JSON.stringify(value);
  return `cap-desktop://action?value=${encodeURIComponent(json)}`;
}

export async function openDeeplink(action: string, value: unknown): Promise<void> {
  const url = buildDeeplink(action, value);
  const { execSync } = await import("node:child_process");
  execSync(`open "${url}"`);
}
